import CoreGraphics
import Foundation
import ImageIO

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3 else {
  fputs("usage: check-simulator-screenshot.swift <image.png> [reference.png]\n", stderr)
  exit(2)
}

let width = 120
let height = 120
let bytesPerPixel = 4
let bytesPerRow = width * bytesPerPixel

func decodePixels(at path: String) -> [UInt8]? {
  let url = URL(fileURLWithPath: path) as CFURL
  guard
    let source = CGImageSourceCreateWithURL(url, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { return nil }

  var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)
  guard let context = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue
      | CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }

  context.interpolationQuality = .low
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return pixels
}

let imagePath = CommandLine.arguments[1]
guard let pixels = decodePixels(at: imagePath) else {
  fputs("Could not decode screenshot: \(imagePath)\n", stderr)
  exit(2)
}

var blackPixels = 0
var whitePixels = 0
var luminanceTotal = 0.0
var luminanceSquaredTotal = 0.0
for offset in stride(from: 0, to: pixels.count, by: bytesPerPixel) {
  let red = pixels[offset]
  let green = pixels[offset + 1]
  let blue = pixels[offset + 2]
  if red < 12 && green < 12 && blue < 12 { blackPixels += 1 }
  if red > 248 && green > 248 && blue > 248 { whitePixels += 1 }

  let luminance = 0.2126 * Double(red) + 0.7152 * Double(green) + 0.0722 * Double(blue)
  luminanceTotal += luminance
  luminanceSquaredTotal += luminance * luminance
}

let total = width * height
let blackRatio = Double(blackPixels) / Double(total)
let whiteRatio = Double(whitePixels) / Double(total)
let meanLuminance = luminanceTotal / Double(total)
let variance = max(0, luminanceSquaredTotal / Double(total) - meanLuminance * meanLuminance)
let luminanceDeviation = sqrt(variance)
print(String(format: "Screenshot pixels: black %.1f%%, white %.1f%%, deviation %.1f", blackRatio * 100, whiteRatio * 100, luminanceDeviation))

if blackRatio > 0.35 || whiteRatio > 0.97 || luminanceDeviation < 12 {
  fputs("Screenshot appears blank or incompletely rendered.\n", stderr)
  exit(1)
}

if CommandLine.arguments.count == 3 {
  let referencePath = CommandLine.arguments[2]
  guard let referencePixels = decodePixels(at: referencePath) else {
    fputs("Could not decode reference screenshot: \(referencePath)\n", stderr)
    exit(2)
  }

  var matchingPixels = 0
  for offset in stride(from: 0, to: pixels.count, by: bytesPerPixel) {
    let redDifference = abs(Int(pixels[offset]) - Int(referencePixels[offset]))
    let greenDifference = abs(Int(pixels[offset + 1]) - Int(referencePixels[offset + 1]))
    let blueDifference = abs(Int(pixels[offset + 2]) - Int(referencePixels[offset + 2]))
    if max(redDifference, greenDifference, blueDifference) <= 45 { matchingPixels += 1 }
  }

  let matchRatio = Double(matchingPixels) / Double(total)
  print(String(format: "Reference-frame match: %.1f%%", matchRatio * 100))
  if matchRatio < 0.55 {
    fputs("Relaunch does not match the fully rendered cold-launch frame.\n", stderr)
    exit(1)
  }
}
