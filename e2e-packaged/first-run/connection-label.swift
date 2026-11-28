import Foundation
import Vision

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.regionOfInterest = CGRect(x: 0, y: 0, width: 0.30, height: 0.16)
let frame = URL(fileURLWithPath: CommandLine.arguments[1])
try VNImageRequestHandler(url: frame, options: [:]).perform([request])
let connected = request.results?.contains {
    $0.topCandidates(1).first?.string
        .split(whereSeparator: \.isNewline)
        .contains(where: { $0.trimmingCharacters(in: .whitespaces).lowercased() == "connected" }) == true
} ?? false
print(connected ? "Connected" : "")
