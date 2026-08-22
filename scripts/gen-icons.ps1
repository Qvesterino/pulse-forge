# Generates PWA icons for Pulse Forge using System.Drawing (Windows).
# Regenerate with:  pwsh -File scripts/gen-icons.ps1
# Outputs into public/: pwa-64x64.png, pwa-192x192.png, pwa-512x512.png,
#                      maskable-512x512.png, apple-touch-icon.png

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot ".." "public"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$bg     = [System.Drawing.Color]::FromArgb(255, 20, 22, 28)    # #14161c
$accent = [System.Drawing.Color]::FromArgb(255, 245, 158, 11)  # #f59e0b

# ECG-style pulse polyline, normalized 0..1 coordinates.
$pulse = @(
    @{ x = 0.08; y = 0.55 },
    @{ x = 0.30; y = 0.55 },
    @{ x = 0.36; y = 0.45 },
    @{ x = 0.42; y = 0.55 },
    @{ x = 0.50; y = 0.15 },
    @{ x = 0.56; y = 0.80 },
    @{ x = 0.62; y = 0.55 },
    @{ x = 0.68; y = 0.50 },
    @{ x = 0.92; y = 0.50 }
)

function New-Canvas([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    return @{ Bmp = $bmp; Gfx = $g }
}

function Get-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-Pulse($gfx, [int]$size, [float]$penScale) {
    $pen = New-Object System.Drawing.Pen($accent, [float]($size * $penScale))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    for ($i = 0; $i -lt $pulse.Count - 1; $i++) {
        $a = $pulse[$i]; $b = $pulse[$i + 1]
        $gfx.DrawLine($pen,
            [float]($a.x * $size), [float]($a.y * $size),
            [float]($b.x * $size), [float]($b.y * $size))
    }
    $pen.Dispose()
}

function Save-Icon([int]$size, [string]$fileName, [bool]$maskable, [float]$penScale) {
    $c = New-Canvas $size
    $gfx = $c.Gfx; $bmp = $c.Bmp
    if ($maskable) {
        # Full-bleed background for maskable safe-zone cropping.
        $gfx.Clear($bg)
    } else {
        # Rounded square with transparency outside.
        $radius = [float]($size * 0.22)
        $path = Get-RoundedRectPath 0 0 $size $size $radius
        $brush = New-Object System.Drawing.SolidBrush($bg)
        $gfx.FillPath($brush, $path)
        $brush.Dispose(); $path.Dispose()
    }
    Draw-Pulse $gfx $size $penScale
    $outPath = Join-Path $outDir $fileName
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $gfx.Dispose(); $bmp.Dispose()
    Write-Host "generated $outPath ($(${size})x$(${size}))"
}

Save-Icon 64  "pwa-64x64.png"      $false 0.10
Save-Icon 192 "pwa-192x192.png"    $false 0.085
Save-Icon 512 "pwa-512x512.png"    $false 0.075
Save-Icon 512 "maskable-512x512.png" $true 0.075
Save-Icon 180 "apple-touch-icon.png" $true 0.09   # Safari: opaque, square
