import CoreGraphics
import Foundation
import ImageIO

guard CommandLine.arguments.count == 2 else {
  fputs("usage: check-simulator-screenshot.swift <image.png>\n", stderr)
  exit(2)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path) as CFURL
guard
  let source = CGImageSourceCreateWithURL(url, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  fputs("Could not decode screenshot: \(path)\n", stderr)
  exit(2)
}

let width = 120
let height = 120
let bytesPerPixel = 4
let bytesPerRow = width * bytesPerPixel
var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)

guard let context = CGContext(
  data: &pixels,
  width: width,
  height: height,
  bitsPerComponent: 8,
  bytesPerRow: bytesPerRow,
  space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  fputs("Could not create screenshot analysis context.\n", stderr)
  exit(2)
}

context.interpolationQuality = .low
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

var blackPixels = 0
var whitePixels = 0
for offset in stride(from: 0, to: pixels.count, by: bytesPerPixel) {
  let red = pixels[offset]
  let green = pixels[offset + 1]
  let blue = pixels[offset + 2]
  if red < 12 && green < 12 && blue < 12 { blackPixels += 1 }
  if red > 248 && green > 248 && blue > 248 { whitePixels += 1 }
}

let total = width * height
let blackRatio = Double(blackPixels) / Double(total)
let whiteRatio = Double(whitePixels) / Double(total)
print(String(format: "Screenshot pixels: black %.1f%%, white %.1f%%", blackRatio * 100, whiteRatio * 100))

if blackRatio > 0.35 || whiteRatio > 0.97 {
  fputs("Screenshot appears blank or incompletely rendered.\n", stderr)
  exit(1)
}
