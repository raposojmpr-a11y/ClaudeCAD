# ClaudeCAD offline (Windows): serves this folder on http://localhost:8765/ and opens it in the browser.
# PowerShell comes with Windows, so nothing needs installing. Close the window to stop.
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$port = 8765
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript'; '.mjs' = 'text/javascript'
  '.wasm' = 'application/wasm'; '.css' = 'text/css'; '.json' = 'application/json'
  '.txt' = 'text/plain; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'; '.go' = 'text/plain; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try { $listener.Start() } catch {
  Write-Host "Could not use port $port (is ClaudeCAD already open?). Opening it anyway."
  Start-Process "http://localhost:$port/"
  exit
}
Write-Host "ClaudeCAD: http://localhost:$port/  (close this window to stop)"
Start-Process "http://localhost:$port/"
while ($listener.IsListening) {
  $context = $listener.GetContext()
  $response = $context.Response
  try {
    $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    if ($file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and [IO.File]::Exists($file)) {
      $bytes = [IO.File]::ReadAllBytes($file)
      $type = $types[[IO.Path]::GetExtension($file).ToLower()]
      if (-not $type) { $type = 'application/octet-stream' }
      $response.ContentType = $type
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
    }
  } catch {
    $response.StatusCode = 500
  } finally {
    $response.Close()
  }
}
