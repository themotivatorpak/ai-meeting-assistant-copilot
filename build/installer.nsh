; Custom NSIS hooks for AI Meeting Assistant Copilot (Not Another AI)
; 1. Checks for Google Chrome or Brave Browser before install (with user confirmation).
; 2. Offers optional OpenAI Codex CLI setup during install (with user confirmation).

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

!macro customInstall
  ; Check if Codex CLI is already installed
  nsExec::Exec 'cmd /c where codex >nul 2>&1'
  Pop $0
  StrCmp $0 "0" codex_done

  ; Ask user if they want to set up Codex CLI for ChatGPT plan sign-in
  MessageBox MB_YESNO|MB_ICONQUESTION "Would you like to install OpenAI Codex CLI now so you can use your ChatGPT account (Plus/Pro recommended)?$\r$\n$\r$\nSelect No to skip this and use an OpenAI or Anthropic API key in Settings instead." IDNO codex_done

  ; Check if Node.js / npm is available
  nsExec::Exec 'cmd /c where npm >nul 2>&1'
  Pop $1
  StrCmp $1 "0" install_codex

  ; Node.js not found -- ask before opening nodejs.org
  MessageBox MB_YESNO|MB_ICONINFORMATION "Node.js is required to install Codex CLI, but it was not detected on this PC.$\r$\n$\r$\nWould you like to open the Node.js download page now? After installing Node.js, you can run: npm install -g @openai/codex && codex login" IDNO codex_done
  ExecShell "open" "https://nodejs.org/"
  Goto codex_done

  install_codex:
  DetailPrint "Installing OpenAI Codex CLI (@openai/codex)..."
  nsExec::ExecToLog 'cmd /c npm install -g @openai/codex'
  Pop $2
  StrCmp $2 "0" launch_codex_login
  MessageBox MB_OK|MB_ICONEXCLAMATION "Codex CLI installation did not complete automatically. You can install it anytime later by running: npm install -g @openai/codex"
  Goto codex_done

  launch_codex_login:
  MessageBox MB_YESNO|MB_ICONINFORMATION "Codex CLI is installed! Would you like to sign in with your ChatGPT account now? (A browser window will open.)" IDNO codex_done
  Exec 'cmd /k codex login'

  codex_done:
!macroend
