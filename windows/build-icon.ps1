# Convert the website's Nightlight artwork to a Windows icon with native sizes.
# Use conventional BGRA bitmap frames at small sizes for Windows shell/csc
# compatibility, with a PNG-compressed 256px frame for large Explorer icons.
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
            if ($size -eq 256) {
                $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            } else {
                $pixels = New-Object IO.BinaryWriter($stream)
                # ICON bitmap height includes the XOR image and AND mask.
                $pixels.Write([int]40)
                $pixels.Write([int]$size)
                $pixels.Write([int]($size * 2))
                $pixels.Write([uint16]1)
                $pixels.Write([uint16]32)
                foreach ($field in 1..6) { $pixels.Write([int]0) }
                $maskStride = [int]([Math]::Ceiling($size / 32.0) * 4)
                $mask = New-Object byte[] ($maskStride * $size)
                for ($row = 0; $row -lt $size; $row++) {
                    for ($x = 0; $x -lt $size; $x++) {
                        $color = $bitmap.GetPixel($x, $size - 1 - $row)
                        $pixels.Write([byte]$color.B)
                        $pixels.Write([byte]$color.G)
                        $pixels.Write([byte]$color.R)
                        $pixels.Write([byte]$color.A)
                        if ($color.A -eq 0) {
                            $index = $row * $maskStride + [int][Math]::Floor($x / 8.0)
                            $mask[$index] = $mask[$index] -bor (128 -shr ($x % 8))
                        }
                    }
                }
                $pixels.Write([byte[]]$mask)
                $pixels.Flush()
            }
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
