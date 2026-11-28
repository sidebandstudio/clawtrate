-- System Events reads and presses both Chromium's accessible controls and macOS sheets.
on flat(valueText)
  set saved to AppleScript's text item delimiters
  set AppleScript's text item delimiters to " "
  set parts to paragraphs of valueText
  set clean to parts as text
  set AppleScript's text item delimiters to saved
  return clean
end flat

on labelOf(itemRef, roleName)
  tell application "System Events"
    if roleName is in {"AXStaticText", "AXHeading"} then
      try
        set visibleLabel to value of itemRef as text
        if visibleLabel is not "" and visibleLabel is not "missing value" then return visibleLabel
      end try
    end if
    repeat with field in {"AXTitle", "AXDescription", "AXPlaceholderValue", "AXHelp"}
      try
        set visibleLabel to value of attribute (contents of field) of itemRef as text
        if visibleLabel is not "" and visibleLabel is not "missing value" then return visibleLabel
      end try
    end repeat
    try
      set visibleLabel to name of itemRef as text
      if visibleLabel is not "missing value" then return visibleLabel
    end try
    return ""
  end tell
end labelOf

on run argv
  set pid to item 1 of argv as integer
  set mode to item 2 of argv
  set target to item 3 of argv
  set output to ""
  tell application "System Events"
    set matches to application processes whose unix id is pid
    if (count of matches) is 0 then return ""
    set appProcess to item 1 of matches
    if (count of windows of appProcess) is 0 then return ""
    if mode is "focus" then
      set frontmost of appProcess to true
      return "ok"
    end if
    if mode is "type" or mode is "enter" then
      if frontmost of appProcess is false then error "Clawtrate lost focus"
      if mode is "type" then
        keystroke target
      else
        key code 36
      end if
      return "ok"
    end if
    set appWindow to front window of appProcess
    if mode is "bounds" then
      set {leftEdge, topEdge} to position of appWindow
      set {windowWidth, windowHeight} to size of appWindow
      return (leftEdge as text) & "," & topEdge & "," & windowWidth & "," & windowHeight
    end if
    set itemsInWindow to {appWindow} & (entire contents of appWindow)
    repeat with itemInList in itemsInWindow
      set uiItem to contents of itemInList
      try
        set roleName to value of attribute "AXRole" of uiItem
      on error
        set roleName to ""
      end try
      if mode is "read" and roleName is "AXWebArea" then
        set output to output & roleName & tab & linefeed
      end if
      if roleName is in {"AXWindow", "AXSheet", "AXDialog", "AXHeading", "AXStaticText", "AXButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXLink", "AXMenuItem", "AXCheckBox", "AXList", "AXLandmarkNavigation"} then
        set labelText to my labelOf(uiItem, roleName)
        if mode is "read" then
          set output to output & roleName & tab & my flat(labelText) & linefeed
        else if mode is "press" and roleName is in {"AXButton", "AXLink", "AXMenuItem"} then
          if labelText is target or (target is "This computer" and labelText starts with "This computer") then
            perform action "AXPress" of uiItem
            return "ok"
          end if
        else if mode is "compose" and roleName is in {"AXTextField", "AXTextArea"} then
          if labelText starts with "Message" then
            set value of attribute "AXFocused" of uiItem to true
            return "ok"
          end if
        end if
      end if
    end repeat
  end tell
  return output
end run
