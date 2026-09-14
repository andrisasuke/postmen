// macOS OS-input QA, restricted to an explicitly identified PostMen process.
// This does not inspect/control browsers or any other application.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }
guard CommandLine.arguments.count >= 4,
      let pid = Int32(CommandLine.arguments[1]),
      let app = NSRunningApplication(processIdentifier: pid),
      let executableName = app.executableURL?.lastPathComponent,
      ["Postmen", "postmen-desktop"].contains(executableName)
else { fail("Expected the live, explicit PostMen QA PID") }
guard AXIsProcessTrusted() else { fail("Accessibility permission is unavailable") }
let action = CommandLine.arguments[2]
let input = (try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[3].utf8))) as! [String: Any]
let root = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(root, 3)
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func children(_ element: AXUIElement) -> [AXUIElement] {
    // The global Apple menu contains unrelated recent apps/documents.
    (attr(element, "AXChildren") as? [AXUIElement] ?? []).filter {
        !["Apple", "AutoFill"].contains(text($0, "AXTitle"))
    }
}
func text(_ element: AXUIElement, _ name: String) -> String { attr(element, name) as? String ?? "" }
func frame(_ element: AXUIElement) -> [String: Double] {
    var point = CGPoint.zero, size = CGSize.zero
    if let p = attr(element, "AXPosition"), CFGetTypeID(p) == AXValueGetTypeID() { AXValueGetValue(p as! AXValue, .cgPoint, &point) }
    if let s = attr(element, "AXSize"), CFGetTypeID(s) == AXValueGetTypeID() { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}
var visits = 0
func find(_ element: AXUIElement, _ test: (AXUIElement) -> Bool, _ depth: Int = 0) -> AXUIElement? {
    visits += 1
    if visits > 5000 || depth > 24 { return nil }
    if test(element) { return element }
    for child in children(element) { if let found = find(child, test, depth + 1) { return found } }
    return nil
}
func dump(_ element: AXUIElement, _ depth: Int = 0) -> [String: Any] {
    visits += 1
    var result: [String: Any] = ["role":text(element,"AXRole"),"title":text(element,"AXTitle"),"description":text(element,"AXDescription"),"subrole":text(element,"AXSubrole"),"value":String(text(element,"AXValue").prefix(180)),"frame":frame(element)]
    if depth < 20 && visits < 2500 { result["children"] = children(element).map { dump($0, depth + 1) } }
    return result
}
func press(_ element: AXUIElement) {
    let error = AXUIElementPerformAction(element, "AXPress" as CFString)
    if error != .success { fail("AXPress failed: \(error.rawValue), \(text(element,"AXTitle"))") }
}
func focusApp() {
    app.activate(options: [])
    AXUIElementSetAttributeValue(root, "AXFrontmost" as CFString, kCFBooleanTrue)
    if let window=(attr(root,"AXWindows") as? [AXUIElement])?.first {
        AXUIElementPerformAction(window,"AXRaise" as CFString)
    }
    for _ in 0..<20 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { break }
        usleep(100000)
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { fail("QA application is not frontmost; input refused") }
}
func flags() -> CGEventFlags {
    var result: CGEventFlags = []
    for flag in input["modifiers"] as? [String] ?? [] {
        switch flag { case "cmd":result.insert(.maskCommand);case "shift":result.insert(.maskShift);case "alt":result.insert(.maskAlternate);case "ctrl":result.insert(.maskControl);default:fail("Unknown modifier") }
    }
    return result
}
let source = CGEventSource(stateID: .hidSystemState)
var result: Any = ["ok":true,"action":action,"pid":pid]
switch action {
case "windows":
    // Screenshot/coordinate lookup does not need a potentially huge picker AX tree.
    result = ["pid":pid,"windows":((CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]]) ?? []).filter { $0[kCGWindowOwnerPID as String] as? Int32 == pid }]
case "environment":
    result = ["pid":pid,"os":ProcessInfo.processInfo.operatingSystemVersionString,"accessibility":AXIsProcessTrusted(),"screenCapture":CGPreflightScreenCaptureAccess(),"postEvent":CGPreflightPostEventAccess(),"screens":NSScreen.screens.map { screen -> [String:Any] in
        func rect(_ r:NSRect)->[String:Double] { ["x":r.origin.x,"y":r.origin.y,"width":r.width,"height":r.height] }
        return ["frame":rect(screen.frame),"visibleFrame":rect(screen.visibleFrame),"scale":screen.backingScaleFactor]
    }]
case "inspect":
    result = ["pid":pid,"frontmost":NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,"tree":dump(root),"windows":((CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]]) ?? []).filter { $0[kCGWindowOwnerPID as String] as? Int32 == pid }]
case "activate": focusApp()
case "restore":
    guard let window=(attr(root,"AXWindows") as? [AXUIElement])?.first else {fail("No QA window")}
    let error=AXUIElementSetAttributeValue(window,"AXMinimized" as CFString,kCFBooleanFalse)
    if error != .success {fail("AX restore failed: \(error.rawValue)")}
    focusApp()
case "menu":
    focusApp()
    var node = attr(root, "AXMenuBar") as! AXUIElement
    for name in input["path"] as! [String] {
        visits = 0
        guard let found = find(node, { text($0,"AXTitle") == name && ["AXMenuBarItem","AXMenuItem"].contains(text($0,"AXRole")) }) else { fail("Menu not found: \(name)") }
        press(found)
        usleep(250000)
        node = found
    }
case "press":
    focusApp()
    guard let element = find(root, { e in
        let name = input["name"] as? String
        let subrole = input["subrole"] as? String
        let role = input["role"] as? String
        return (name == nil || [text(e,"AXTitle"),text(e,"AXDescription"),text(e,"AXValue")].contains(name!)) && (subrole == nil || text(e,"AXSubrole") == subrole) && (role == nil || text(e,"AXRole") == role)
    }) else { fail("AX target not found: \(input)") }
    result = ["ok":true,"target":dump(element)]
    press(element)
case "key":
    focusApp()
    let code = CGKeyCode(input["code"] as! Int)
    let modifiers: [(CGKeyCode, CGEventFlags)] = [(55,.maskCommand),(56,.maskShift),(58,.maskAlternate),(59,.maskControl)]
        .filter { flags().contains($0.1) }
    var currentFlags: CGEventFlags = []
    for (key, flag) in modifiers {
        currentFlags.insert(flag)
        let event=CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:true)!
        event.flags=currentFlags;event.post(tap:.cghidEventTap);usleep(20000)
    }
    for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
        event.flags = flags()
        if down && input["repeat"] as? Bool == true {
            event.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
        }
        event.post(tap: .cghidEventTap)
        usleep(20000)
    }
    for (key, flag) in modifiers.reversed() {
        currentFlags.remove(flag)
        let event=CGEvent(keyboardEventSource:source,virtualKey:key,keyDown:false)!
        event.flags=currentFlags;event.post(tap:.cghidEventTap);usleep(20000)
    }
case "type":
    focusApp()
    let utf16 = Array((input["text"] as! String).utf16)
    for offset in stride(from:0,to:utf16.count,by:20) {
        let chunk = Array(utf16[offset..<min(offset+20,utf16.count)])
        for down in [true,false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
            event.flags=[]
            event.keyboardSetUnicodeString(stringLength:chunk.count,unicodeString:chunk)
            event.post(tap:.cghidEventTap)
            usleep(15000)
        }
        usleep(25000)
    }
case "click", "drag":
    focusApp()
    let start = CGPoint(x:input["x"] as! Double,y:input["y"] as! Double)
    let windows = attr(root,"AXWindows") as? [AXUIElement] ?? []
    guard windows.contains(where: { let r=frame($0);return CGRect(x:r["x"]!,y:r["y"]!,width:r["width"]!,height:r["height"]!).contains(start) }) else { fail("Pointer start is outside the QA application's windows") }
    func mouse(_ type:CGEventType,_ point:CGPoint) { let event=CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:point,mouseButton:.left)!;event.flags=flags();event.post(tap:.cghidEventTap) }
    mouse(.mouseMoved,start);usleep(100000);mouse(.leftMouseDown,start);usleep(100000)
    var end=start
    if action == "drag" {
        end=CGPoint(x:input["toX"] as! Double,y:input["toY"] as! Double)
        for i in 1...20 {let t=Double(i)/20;mouse(.leftMouseDragged,CGPoint(x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t));usleep(18000)}
    }
    mouse(.leftMouseUp,end)
case "size":
    focusApp()
    guard let window=(attr(root,"AXWindows") as? [AXUIElement])?.first else {fail("No QA window")}
    var size=CGSize(width:input["width"] as! Double,height:input["height"] as! Double)
    let error=AXUIElementSetAttributeValue(window,"AXSize" as CFString,AXValueCreate(.cgSize,&size)!)
    if error != .success {fail("AXSize failed: \(error.rawValue)")}
case "position":
    focusApp()
    guard let window=(attr(root,"AXWindows") as? [AXUIElement])?.first else {fail("No QA window")}
    var point=CGPoint(x:input["x"] as! Double,y:input["y"] as! Double)
    let error=AXUIElementSetAttributeValue(window,"AXPosition" as CFString,AXValueCreate(.cgPoint,&point)!)
    if error != .success {fail("AXPosition failed: \(error.rawValue)")}
default: fail("Unknown QA OS action")
}
let bytes=try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
print(String(data:bytes,encoding:.utf8)!)
