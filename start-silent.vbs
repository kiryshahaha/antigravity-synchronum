Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Ensure build exists
If Not fso.FileExists(strDir & "\dist\sidecar-server.js") Then
    WshShell.Run "cmd /c cd /d """ & strDir & """ && npm run build", 0, True
End If

' Launch node silently (0 = SW_HIDE, hidden window)
strCmd = "cmd /c node --experimental-sqlite """ & strDir & "\dist\sidecar-server.js"""
WshShell.CurrentDirectory = strDir
WshShell.Run strCmd, 0, False

' Wait 1 sec and open dashboard in default browser
WScript.Sleep 1000
WshShell.Run "cmd /c start http://localhost:42125", 0, False
