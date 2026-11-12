; Custom NSIS hooks for AI Meeting Assistant Copilot (Not Another AI)
; Checks for Google Chrome or Brave Browser and asks user before opening download page.

!macro customInit
  StrCpy $0 ""

  ; Check Google Chrome (HKLM and HKCU App Paths)
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
  StrCmp $0 "" 0 browser_found
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" ""
  StrCmp $0 "" 0 browser_found

  ; Check Brave Browser (HKLM and HKCU App Paths)
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\brave.exe" ""
  StrCmp $0 "" 0 browser_found
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\brave.exe" ""
  StrCmp $0 "" 0 browser_found

  ; Neither Chrome nor Brave detected -- ask user before opening download page
  MessageBox MB_YESNO|MB_ICONINFORMATION "Google Chrome or Brave Browser was not detected on this PC.$\r$\n$\r$\nAI Meeting Assistant Copilot uses Chrome or Brave for browser session integration.$\r$\n$\r$\nWould you like to open the Google Chrome download page now? (Select No to continue installing anyway.)" IDNO browser_found
  ExecShell "open" "https://www.google.com/chrome/"

  browser_found:
!macroend
