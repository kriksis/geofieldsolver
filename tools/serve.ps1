# Local dev server for the project folder (no Node/Python needed).
#   powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8765]
# App:   http://localhost:8765/docs/
# Build: http://localhost:8765/tools/build.html  (POST /save writes files under data/ only)
param([int]$Port = 8765)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dataDir = Join-Path $root 'data'
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.gpx' = 'application/gpx+xml; charset=utf-8'; '.zip' = 'application/zip'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$Port/docs/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ($req.HttpMethod -eq 'POST' -and $rel -eq 'save') {
      $target = [IO.Path]::GetFullPath((Join-Path $root $req.QueryString['path']))
      if (-not $target.StartsWith($dataDir + [IO.Path]::DirectorySeparatorChar)) { throw [UnauthorizedAccessException] 'Only data/ is writable' }
      $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
      [IO.File]::WriteAllText($target, $reader.ReadToEnd(), (New-Object Text.UTF8Encoding($false)))
      $bytes = [Text.Encoding]::UTF8.GetBytes('saved')
    } else {
      $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
      if (Test-Path $path -PathType Container) { $path = Join-Path $path 'index.html' }
      if (-not $path.StartsWith($root) -or -not (Test-Path $path -PathType Leaf)) { $res.StatusCode = 404; $bytes = [Text.Encoding]::UTF8.GetBytes('not found') }
      else {
        $bytes = [IO.File]::ReadAllBytes($path)
        $ext = [IO.Path]::GetExtension($path).ToLower()
        $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-store')
      }
    }
  } catch {
    $res.StatusCode = 500; $bytes = [Text.Encoding]::UTF8.GetBytes($_.Exception.Message)
  }
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
  $res.Close()
}
