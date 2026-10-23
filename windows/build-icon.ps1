# Convert the website's Nightlight artwork to a Windows icon with native sizes.
# PNG frames preserve alpha and are supported by Windows 10/11 and Inno Setup.
[CmdletBinding()]
param([Parameter(Mandatory)] [string] $Source, [Parameter(Mandatory)] [string] $Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$sizes = @(16, 20, 24, 32, 48, 64, 128, 256)
$frames = New-Object 'System.Collections.Generic.List[byte[]]'
$image = [Drawing.Image]::FromFile($Source)
try {
    foreach ($size in $sizes) {
        $bitmap = New-Object Drawing.Bitmap($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object IO.MemoryStream
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($image, 0, 0, $size, $size)
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $frames.Add($stream.ToArray())
        } finally {
            $stream.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally { $image.Dispose() }

$file = [IO.File]::Create($Destination)
$writer = New-Object IO.BinaryWriter($file)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($index = 0; $index -lt $sizes.Count; $index++) {
        $dimension = [byte]($sizes[$index] % 256)
        $writer.Write($dimension)
        $writer.Write($dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([int]$frames[$index].Length)
        $writer.Write([int]$offset)
        $offset += $frames[$index].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
} finally {
    $writer.Dispose()
    $file.Dispose()
}
