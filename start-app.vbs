Set WshShell = CreateObject("WScript.Shell")
appDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = appDir
' 0 = hidden window, False = do not wait
WshShell.Run "cmd /c """ & appDir & "\start-app.bat""", 0, False
