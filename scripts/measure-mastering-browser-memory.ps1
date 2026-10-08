param(
  [ValidateSet("flac-cap", "mp3-session-soak", "wav-session-soak", "project-12-minute-wav-soak")]
  [string]$Workload = "flac-cap",
  [ValidateSet("chromium", "firefox-mastering-session")]
  [string]$Browser = "chromium",
  [int]$SampleIntervalMs = 250
)

$ErrorActionPreference = "Stop"

function ConvertTo-WindowsCommandLineArgument([string]$value) {
  $escaped = [System.Text.RegularExpressions.Regex]::Replace($value, '(\\*)"', '$1$1\"')
  $escaped = [System.Text.RegularExpressions.Regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

if ($SampleIntervalMs -lt 100 -or $SampleIntervalMs -gt 5000) {
  throw "SampleIntervalMs must be between 100 and 5000."
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeCommand = (Get-Command "node.exe" -ErrorAction Stop).Source
$playwrightCli = Join-Path $repositoryRoot "node_modules/playwright/cli.js"
if (-not (Test-Path -LiteralPath $playwrightCli)) {
  throw "Playwright CLI was not found at $playwrightCli. Run npm install first."
}
$stdoutPath = [System.IO.Path]::GetTempFileName()
$stderrPath = [System.IO.Path]::GetTempFileName()
$markerPath = [System.IO.Path]::GetTempFileName()
$markerVariable = "KYX_MASTERING_MEMORY_MARKER"
$previousMarker = [Environment]::GetEnvironmentVariable($markerVariable, "Process")
$markerEnvironmentChanged = $false
$grepPattern = switch ($Workload) {
  "flac-cap" { "high-entropy.*FLAC" }
  "mp3-session-soak" { "external-MP3-memory-soak" }
  "wav-session-soak" { "external-WAV-memory-soak" }
  "project-12-minute-wav-soak" { "renders, analyzes, and exports a 12-minute master" }
}
$browserProcessPattern = switch ($Browser) {
  "chromium" {
    [pscustomobject]@{
      Label = "Chromium"
      ExecutablePath = "\\ms-playwright\\chromium(_headless_shell)?-[^\\]+\\"
      ProcessName = "^(chrome|chrome-headless-shell)\.exe$"
    }
  }
  "firefox-mastering-session" {
    [pscustomobject]@{
      Label = "Firefox"
      ExecutablePath = "\\ms-playwright\\firefox-[^\\]+\\"
      ProcessName = "^(firefox|plugin-container)\.exe$"
    }
  }
}
$browserLabel = $browserProcessPattern.Label
$arguments = @(
  $playwrightCli,
  "test",
  "tests/e2e/17-mastering-workspace.spec.ts",
  "--grep=$grepPattern",
  "--project=$Browser",
  "--workers=1"
)
$process = $null

try {
  [Environment]::SetEnvironmentVariable($markerVariable, $markerPath, "Process")
  $markerEnvironmentChanged = $true
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodeCommand
  $startInfo.WorkingDirectory = $repositoryRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Arguments = (($arguments | ForEach-Object {
    ConvertTo-WindowsCommandLineArgument ([string]$_)
  }) -join " ")
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Could not start the Playwright process."
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  [Environment]::SetEnvironmentVariable($markerVariable, $previousMarker, "Process")
  $markerEnvironmentChanged = $false

  $peakBytes = 0L
  $peakProcesses = @()
  $peakPrivateBytes = 0L
  $peakPrivateProcesses = @()
  $encodeBaselineBytes = $null
  $encodePeakBytes = 0L
  $encodePeakProcesses = @()
  $encodeOnlyPeakBytes = 0L
  $encodeOnlyPeakProcesses = @()
  $encodeBaselinePrivateBytes = $null
  $encodePeakPrivateBytes = 0L
  $encodePeakPrivateProcesses = @()
  $encodeOnlyPeakPrivateBytes = 0L
  $encodeOnlyPeakPrivateProcesses = @()
  $inspectionBaselineBytes = $null
  $inspectionPeakBytes = 0L
  $inspectionPeakProcesses = @()
  $inspectionBaselinePrivateBytes = $null
  $inspectionPeakPrivateBytes = 0L
  $inspectionPeakPrivateProcesses = @()
  $previousSampleBytes = $null
  $previousSamplePrivateBytes = $null
  $stage = ""
  $sampleCount = 0
  $nextSampleAt = [DateTime]::UtcNow

  while (-not $process.HasExited) {
    $currentStage = ""
    try {
      $currentStage = [System.IO.File]::ReadAllText($markerPath).Trim()
    }
    catch {
      $currentStage = ""
    }
    if ($currentStage -ne $stage) {
      if ($currentStage -eq "encode-start" -and $null -ne $previousSampleBytes) {
        $encodeBaselineBytes = [long]$previousSampleBytes
        $encodeBaselinePrivateBytes = [long]$previousSamplePrivateBytes
      }
      if ($currentStage -eq "inspection-start" -and $null -ne $previousSampleBytes) {
        $inspectionBaselineBytes = [long]$previousSampleBytes
        $inspectionBaselinePrivateBytes = [long]$previousSamplePrivateBytes
        $encodeOnlyPeakBytes = $encodePeakBytes
        $encodeOnlyPeakProcesses = $encodePeakProcesses
        $encodeOnlyPeakPrivateBytes = $encodePeakPrivateBytes
        $encodeOnlyPeakPrivateProcesses = $encodePeakPrivateProcesses
      }
      $stage = $currentStage
    }

    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $descendantIds = [System.Collections.Generic.HashSet[int]]::new()
    [void]$descendantIds.Add($process.Id)
    $added = $true
    while ($added) {
      $added = $false
      foreach ($candidate in $allProcesses) {
        if ($descendantIds.Contains([int]$candidate.ParentProcessId) -and $descendantIds.Add([int]$candidate.ProcessId)) {
          $added = $true
        }
      }
    }

    $browserProcesses = @($allProcesses | Where-Object {
      $descendantIds.Contains([int]$_.ProcessId) -and
      $_.ExecutablePath -match $browserProcessPattern.ExecutablePath -and
      $_.Name -match $browserProcessPattern.ProcessName
    })

    $sample = @($browserProcesses | ForEach-Object {
      try {
        $browserProcess = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
        $browserProcess.Refresh()
        [pscustomobject]@{
          Id = [int]$_.ProcessId
          Name = [string]$_.Name
          WorkingSetBytes = [long]$browserProcess.WorkingSet64
          PrivateMemoryBytes = [long]$browserProcess.PrivateMemorySize64
        }
      }
      catch {
        $null
      }
    } | Where-Object { $null -ne $_ })

    $sampleBytes = [long](($sample | Measure-Object -Property WorkingSetBytes -Sum).Sum)
    $samplePrivateBytes = [long](($sample | Measure-Object -Property PrivateMemoryBytes -Sum).Sum)
    $sampleCount++
    if ($sampleBytes -gt $peakBytes) {
      $peakBytes = $sampleBytes
      $peakProcesses = $sample
    }
    if ($samplePrivateBytes -gt $peakPrivateBytes) {
      $peakPrivateBytes = $samplePrivateBytes
      $peakPrivateProcesses = $sample
    }
    if ($stage -in @("encode-start", "inspection-start") -and $sampleBytes -gt $encodePeakBytes) {
      $encodePeakBytes = $sampleBytes
      $encodePeakProcesses = $sample
    }
    if ($stage -in @("encode-start", "inspection-start") -and $samplePrivateBytes -gt $encodePeakPrivateBytes) {
      $encodePeakPrivateBytes = $samplePrivateBytes
      $encodePeakPrivateProcesses = $sample
    }
    if ($stage -eq "encode-start" -and $sampleBytes -gt $encodeOnlyPeakBytes) {
      $encodeOnlyPeakBytes = $sampleBytes
      $encodeOnlyPeakProcesses = $sample
    }
    if ($stage -eq "encode-start" -and $samplePrivateBytes -gt $encodeOnlyPeakPrivateBytes) {
      $encodeOnlyPeakPrivateBytes = $samplePrivateBytes
      $encodeOnlyPeakPrivateProcesses = $sample
    }
    if ($stage -eq "inspection-start" -and $sampleBytes -gt $inspectionPeakBytes) {
      $inspectionPeakBytes = $sampleBytes
      $inspectionPeakProcesses = $sample
    }
    if ($stage -eq "inspection-start" -and $samplePrivateBytes -gt $inspectionPeakPrivateBytes) {
      $inspectionPeakPrivateBytes = $samplePrivateBytes
      $inspectionPeakPrivateProcesses = $sample
    }
    $previousSampleBytes = $sampleBytes
    $previousSamplePrivateBytes = $samplePrivateBytes

    $nextSampleAt = $nextSampleAt.AddMilliseconds($SampleIntervalMs)
    $delay = [int][Math]::Max(0, ($nextSampleAt - [DateTime]::UtcNow).TotalMilliseconds)
    if ($delay -gt 0) {
      Start-Sleep -Milliseconds $delay
    }
  }

  $process.WaitForExit()
  [System.IO.File]::WriteAllText($stdoutPath, $stdoutTask.GetAwaiter().GetResult())
  [System.IO.File]::WriteAllText($stderrPath, $stderrTask.GetAwaiter().GetResult())
  Write-Output "Playwright output:"
  Get-Content -LiteralPath $stdoutPath
  if ((Get-Item -LiteralPath $stderrPath).Length -gt 0) {
    Write-Output "Playwright stderr:"
    Get-Content -LiteralPath $stderrPath
  }
  Write-Output ("Peak {0} process-tree working set: {1:N1} MiB" -f $browserLabel, ($peakBytes / 1MB))
  Write-Output ("Peak {0} process-tree private bytes: {1:N1} MiB" -f $browserLabel, ($peakPrivateBytes / 1MB))
  Write-Output ("Sampling interval: {0} ms target; samples: {1}" -f $SampleIntervalMs, $sampleCount)
  if ($null -ne $encodeBaselineBytes -and $encodePeakBytes -gt 0) {
    $encodeDeltaBytes = [Math]::Max(0L, ($encodePeakBytes - [long]$encodeBaselineBytes))
    Write-Output ("Browser-process baseline before mastering export: {0:N1} MiB" -f ($encodeBaselineBytes / 1MB))
    Write-Output ("Peak during mastering export and inspection: {0:N1} MiB" -f ($encodePeakBytes / 1MB))
    Write-Output ("Export working-set increase over source baseline: {0:N1} MiB" -f ($encodeDeltaBytes / 1MB))
    if ($null -ne $encodeBaselinePrivateBytes -and $encodePeakPrivateBytes -gt 0) {
      $privateDeltaBytes = [Math]::Max(0L, ($encodePeakPrivateBytes - [long]$encodeBaselinePrivateBytes))
      Write-Output ("Browser-process private-bytes baseline before mastering export: {0:N1} MiB" -f ($encodeBaselinePrivateBytes / 1MB))
      Write-Output ("Peak private bytes during mastering export and inspection: {0:N1} MiB" -f ($encodePeakPrivateBytes / 1MB))
      Write-Output ("Export private-bytes increase over source baseline: {0:N1} MiB" -f ($privateDeltaBytes / 1MB))
    }
    if ($encodeOnlyPeakBytes -gt 0) {
      Write-Output ("Encode-phase peak before inspection: {0:N1} MiB" -f ($encodeOnlyPeakBytes / 1MB))
      Write-Output ("{0} processes at encode-phase peak:" -f $browserLabel)
      $encodeOnlyPeakProcesses | Sort-Object WorkingSetBytes -Descending | ForEach-Object {
        Write-Output ("  {0} PID {1}: {2:N1} MiB" -f $_.Name, $_.Id, ($_.WorkingSetBytes / 1MB))
      }
    }
    if ($encodeOnlyPeakPrivateBytes -gt 0 -and $null -ne $encodeBaselinePrivateBytes) {
      $encodePrivateDeltaBytes = [Math]::Max(0L, ($encodeOnlyPeakPrivateBytes - [long]$encodeBaselinePrivateBytes))
      Write-Output ("Encode-phase private-bytes increase before inspection: {0:N1} MiB" -f ($encodePrivateDeltaBytes / 1MB))
      Write-Output ("{0} processes at encode-phase private-bytes peak:" -f $browserLabel)
      $encodeOnlyPeakPrivateProcesses | Sort-Object PrivateMemoryBytes -Descending | ForEach-Object {
        Write-Output ("  {0} PID {1}: {2:N1} MiB" -f $_.Name, $_.Id, ($_.PrivateMemoryBytes / 1MB))
      }
    }
    if ($null -ne $inspectionBaselineBytes -and $inspectionPeakBytes -gt 0) {
      $inspectionDeltaBytes = [Math]::Max(0L, ($inspectionPeakBytes - [long]$inspectionBaselineBytes))
      Write-Output ("Post-encode inspection baseline: {0:N1} MiB" -f ($inspectionBaselineBytes / 1MB))
      Write-Output ("Peak during post-encode inspection: {0:N1} MiB" -f ($inspectionPeakBytes / 1MB))
      Write-Output ("Post-encode inspection working-set increase: {0:N1} MiB" -f ($inspectionDeltaBytes / 1MB))
      Write-Output ("{0} processes at inspection peak:" -f $browserLabel)
      $inspectionPeakProcesses | Sort-Object WorkingSetBytes -Descending | ForEach-Object {
        Write-Output ("  {0} PID {1}: {2:N1} MiB" -f $_.Name, $_.Id, ($_.WorkingSetBytes / 1MB))
      }
    }
    if ($null -ne $inspectionBaselinePrivateBytes -and $inspectionPeakPrivateBytes -gt 0) {
      $inspectionPrivateDeltaBytes = [Math]::Max(0L, ($inspectionPeakPrivateBytes - [long]$inspectionBaselinePrivateBytes))
      Write-Output ("Post-encode inspection private-bytes baseline: {0:N1} MiB" -f ($inspectionBaselinePrivateBytes / 1MB))
      Write-Output ("Peak private bytes during post-encode inspection: {0:N1} MiB" -f ($inspectionPeakPrivateBytes / 1MB))
      Write-Output ("Post-encode inspection private-bytes increase: {0:N1} MiB" -f ($inspectionPrivateDeltaBytes / 1MB))
      Write-Output ("{0} processes at inspection private-bytes peak:" -f $browserLabel)
      $inspectionPeakPrivateProcesses | Sort-Object PrivateMemoryBytes -Descending | ForEach-Object {
        Write-Output ("  {0} PID {1}: {2:N1} MiB" -f $_.Name, $_.Id, ($_.PrivateMemoryBytes / 1MB))
      }
    }
    Write-Output ("{0} processes at mastering-export peak:" -f $browserLabel)
    $encodePeakProcesses | Sort-Object WorkingSetBytes -Descending | ForEach-Object {
      Write-Output ("  {0} PID {1}: {2:N1} MiB" -f $_.Name, $_.Id, ($_.WorkingSetBytes / 1MB))
    }
  }
  else {
    Write-Output "Encode-phase marker was not observed; no baseline-adjusted encode memory is available."
  }
  Write-Output ("{0} processes at whole-run peak:" -f $browserLabel)
  $peakProcesses | Sort-Object WorkingSetBytes -Descending | ForEach-Object {
    Write-Output ("  {0} PID {1}: {2:N1} MiB" -f $_.Name, $_.Id, ($_.WorkingSetBytes / 1MB))
  }
  Write-Output ("{0} processes at whole-run private-bytes peak:" -f $browserLabel)
  $peakPrivateProcesses | Sort-Object PrivateMemoryBytes -Descending | ForEach-Object {
    Write-Output ("  {0} PID {1}: {2:N1} MiB" -f $_.Name, $_.Id, ($_.PrivateMemoryBytes / 1MB))
  }

  $playwrightExitCode = $process.ExitCode
  if ($null -eq $playwrightExitCode) {
    throw "Could not read the Playwright process exit code."
  }
  if ([int]$playwrightExitCode -ne 0) {
    throw "Playwright exited with code $playwrightExitCode."
  }
  if (
    $peakBytes -le 0 -or
    $peakPrivateBytes -le 0 -or
    $sampleCount -le 0 -or
    $null -eq $encodeBaselineBytes -or
    $null -eq $encodeBaselinePrivateBytes -or
    $encodePeakBytes -le 0 -or
    $encodePeakPrivateBytes -le 0
  ) {
    throw "No $browserLabel process memory samples were collected."
  }
}
finally {
  if ($markerEnvironmentChanged) {
    [Environment]::SetEnvironmentVariable($markerVariable, $previousMarker, "Process")
  }
  if ($null -ne $process -and -not $process.HasExited) {
    $process.Kill($true)
  }
  if ($null -ne $process) {
    $process.Dispose()
  }
  Remove-Item -LiteralPath $stdoutPath, $stderrPath, $markerPath -Force -ErrorAction SilentlyContinue
}
