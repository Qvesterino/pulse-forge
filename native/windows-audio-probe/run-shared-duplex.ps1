[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$CaptureEndpoint,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$RenderEndpoint,

  [ValidateRange(1, 30)]
  [int]$Seconds = 10,

  [string]$ProbePath = (Join-Path $env:TEMP 'kyx-windows-audio-probe/Release/kyx-windows-audio-probe.exe')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProbePath -PathType Leaf)) {
  throw "Probe executable not found: $ProbePath. Build native/windows-audio-probe first."
}

function ConvertTo-NativeArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]'\') {
      $backslashes++
      continue
    }
    if ($character -eq [char]'"') {
      for ($index = 0; $index -lt (2 * $backslashes + 1); $index++) { [void]$builder.Append('\') }
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    for ($index = 0; $index -lt $backslashes; $index++) { [void]$builder.Append('\') }
    [void]$builder.Append($character)
    $backslashes = 0
  }
  for ($index = 0; $index -lt (2 * $backslashes); $index++) { [void]$builder.Append('\') }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Start-ProbeProcess {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $ProbePath
  $startInfo.Arguments = [string]::Join(' ', @($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }))
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  return [System.Diagnostics.Process]::Start($startInfo)
}

function Stop-OwnedProbeProcess {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ($Process.HasExited) { return }
  try {
    $Process.Kill()
    if (-not $Process.WaitForExit(5000)) {
      throw "The owned $Label probe did not exit after termination."
    }
  } catch {
    [Console]::Error.WriteLine("Could not stop owned $Label probe: $($_.Exception.Message)")
    $script:exitCode = 1
  }
}

function Read-ProbeOutput {
  param(
    [Parameter(Mandatory = $true)][System.Threading.Tasks.Task[string]]$Task,
    [Parameter(Mandatory = $true)][string]$Label
  )

  try {
    if (-not $Task.Wait(5000)) {
      [Console]::Error.WriteLine("Timed out collecting $Label from an owned probe process.")
      $script:exitCode = 1
      return "<timed out collecting $Label>"
    }
    return $Task.GetAwaiter().GetResult()
  } catch {
    [Console]::Error.WriteLine("Could not collect $Label from an owned probe process: $($_.Exception.Message)")
    $script:exitCode = 1
    return "<failed collecting $Label>"
  }
}

$captureProcess = $null
$renderProcess = $null
$exitCode = 0
try {
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $captureProcess = Start-ProbeProcess @('--stream-test', 'capture', 'shared', $CaptureEndpoint, [string]$Seconds)
  $captureOutputTask = $captureProcess.StandardOutput.ReadToEndAsync()
  $captureErrorTask = $captureProcess.StandardError.ReadToEndAsync()

  $renderProcess = Start-ProbeProcess @('--stream-test', 'render', 'shared', $RenderEndpoint, [string]$Seconds)
  $renderOutputTask = $renderProcess.StandardOutput.ReadToEndAsync()
  $renderErrorTask = $renderProcess.StandardError.ReadToEndAsync()

  $timeoutMs = ($Seconds + 15) * 1000
  while ((-not $captureProcess.HasExited -or -not $renderProcess.HasExited) -and $watch.ElapsedMilliseconds -lt $timeoutMs) {
    Start-Sleep -Milliseconds 100
  }
  $watch.Stop()

  $timedOut = -not $captureProcess.HasExited -or -not $renderProcess.HasExited
  if ($timedOut) {
    $timeoutMessage = "The concurrent probe exceeded its $($Seconds + 15)-second safety timeout; stopping both streams."
    [Console]::Error.WriteLine($timeoutMessage)
    $exitCode = 1
    Stop-OwnedProbeProcess $captureProcess 'capture'
    Stop-OwnedProbeProcess $renderProcess 'render'
  }

  if ($timedOut) {
    Write-Output "Concurrent shared-WASAPI capture/render smoke timed out after $([math]::Round($watch.Elapsed.TotalSeconds, 2)) s."
  } else {
    Write-Output "Concurrent shared-WASAPI capture/render smoke completed in $([math]::Round($watch.Elapsed.TotalSeconds, 2)) s."
  }
  Write-Output 'Capture PCM is discarded; render sends silence. This does not measure physical loopback or round-trip latency.'
  Write-Output '--- CAPTURE ---'
  Write-Output (Read-ProbeOutput $captureOutputTask 'capture stdout')
  $captureError = Read-ProbeOutput $captureErrorTask 'capture stderr'
  if ($captureError) { [Console]::Error.WriteLine($captureError) }
  Write-Output '--- RENDER ---'
  Write-Output (Read-ProbeOutput $renderOutputTask 'render stdout')
  $renderError = Read-ProbeOutput $renderErrorTask 'render stderr'
  if ($renderError) { [Console]::Error.WriteLine($renderError) }

  if (-not $timedOut -and ($captureProcess.ExitCode -ne 0 -or $renderProcess.ExitCode -ne 0)) {
    $exitCode = 1
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $exitCode = 1
} finally {
  foreach ($process in @($captureProcess, $renderProcess)) {
    if ($null -ne $process) {
      $label = if ($process -eq $captureProcess) { 'capture' } else { 'render' }
      Stop-OwnedProbeProcess $process $label
      $process.Dispose()
    }
  }
}

exit $exitCode
