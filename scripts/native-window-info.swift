// Read-only list of this project's native windows; does not inspect other apps.
import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let own = windows.filter { window in
    let owner = window[kCGWindowOwnerName as String] as? String ?? ""
    let targetPID = CommandLine.arguments.dropFirst().first.flatMap(Int.init)
    return owner.lowercased().contains("postmen") && (targetPID == nil || window[kCGWindowOwnerPID as String] as? Int == targetPID)
}
let data = try JSONSerialization.data(withJSONObject: own, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
