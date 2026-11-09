# Renders logo.png — the four-point star with the twin centre cut-outs.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\render-logo.ps1
#
# Geometry is parametric so the shape can be retuned without a vector editor:
#   $k    smaller  -> thinner arms (deeper concave waist)
#   $holeW/$holeH  size of each black diamond
#   $holeGap       red bar between the two diamonds

param(
  [int]$Size = 1024,
  [string]$Color = "#FF0D0D",
  [string]$Out = "logo.png"
)

Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }

$pad = 0.97
$R = ($Size / 2.0) * $pad
$cx = $Size / 2.0
$cy = $Size / 2.0
$k = 0.118 * $Size

# tips and concavity control points, cargo-culted from the reference art
$top = [System.Drawing.PointF]::new($cx, $cy - $R)
$right = [System.Drawing.PointF]::new($cx + $R, $cy)
$bottom = [System.Drawing.PointF]::new($cx, $cy + $R)
$left = [System.Drawing.PointF]::new($cx - $R, $cy)

$cTR = [System.Drawing.PointF]::new($cx + $k, $cy - $k)
$cRB = [System.Drawing.PointF]::new($cx + $k, $cy + $k)
$cBL = [System.Drawing.PointF]::new($cx - $k, $cy + $k)
$cLT = [System.Drawing.PointF]::new($cx - $k, $cy - $k)

$pts = New-Object 'System.Collections.Generic.List[System.Drawing.PointF]'

function Add-Quad {
  param($List, $P0, $C, $P1, [int]$Steps = 96)
  for ($i = 0; $i -lt $Steps; $i++) {
    $t = $i / [double]$Steps
    $mt = 1.0 - $t
    $x = $mt * $mt * $P0.X + 2 * $mt * $t * $C.X + $t * $t * $P1.X
    $y = $mt * $mt * $P0.Y + 2 * $mt * $t * $C.Y + $t * $t * $P1.Y
    $List.Add([System.Drawing.PointF]::new([single]$x, [single]$y))
  }
}

Add-Quad -List $pts -P0 $top    -C $cTR -P1 $right
Add-Quad -List $pts -P0 $right  -C $cRB -P1 $bottom
Add-Quad -List $pts -P0 $bottom -C $cBL -P1 $left
Add-Quad -List $pts -P0 $left   -C $cLT -P1 $top

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.FillMode = [System.Drawing.Drawing2D.FillMode]::Alternate
$path.AddPolygon($pts.ToArray())

# twin diamonds: each is a rhombus, and the gap between them stays red
$holeW = 0.106 * $Size     # half width of one diamond
$holeH = 0.088 * $Size     # half height of one diamond
$holeGap = 0.021 * $Size   # half the red bar between them

foreach ($sign in @(-1, 1)) {
  $hx = $cx + $sign * ($holeGap + $holeW)
  $diamond = @(
    [System.Drawing.PointF]::new([single]$hx,               [single]($cy - $holeH)),
    [System.Drawing.PointF]::new([single]($hx + $holeW),    [single]$cy),
    [System.Drawing.PointF]::new([single]$hx,               [single]($cy + $holeH)),
    [System.Drawing.PointF]::new([single]($hx - $holeW),    [single]$cy)
  )
  $path.AddPolygon($diamond)
}

$bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

$brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($Color))
$g.FillPath($brush, $path)

$g.Dispose()
$brush.Dispose()

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$path.Dispose()

$info = Get-Item $outPath
Write-Host ("wrote {0}  {1}x{1}  {2:N0} KB" -f $info.Name, $Size, ($info.Length / 1KB))
