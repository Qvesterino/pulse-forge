[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [string]$ModelRoot = (Join-Path $env:USERPROFILE "Documents\Magenta\magenta-rt-v2-windows")
)

$expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Documents\Magenta\magenta-rt-v2-windows"))
$resolvedRoot = [IO.Path]::GetFullPath($ModelRoot)
if ($resolvedRoot -ne $expectedRoot) {
  throw "Refusing to remove an unexpected MRT2 model root. Expected: $expectedRoot"
}
if (Test-Path -LiteralPath $resolvedRoot) {
  if ($PSCmdlet.ShouldProcess($resolvedRoot, "Remove KYX MRT2 Windows model assets")) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -Confirm:$false
    Write-Output "Removed $resolvedRoot"
  }
} else {
  Write-Output "MRT2 Windows model root is already absent: $resolvedRoot"
}
