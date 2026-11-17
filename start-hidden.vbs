' Fully hide the console (no taskbar window).
' Stop the app via Task Manager if needed (node / skill-panel).
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c start.bat --min", 0, False
