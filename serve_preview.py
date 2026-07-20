from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
import socket
import webbrowser

PORT = 8765
ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.webmanifest': 'application/manifest+json',
        '.js': 'text/javascript; charset=utf-8',
        '.gubackup': 'application/zip',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

try:
    hostname = socket.gethostname()
    lan_ip = socket.gethostbyname(hostname)
except Exception:
    lan_ip = '本机局域网IP'

print('=' * 58)
print('谷子收纳 PWA 本地预览')
print('=' * 58)
print(f'电脑访问：http://127.0.0.1:{PORT}')
print(f'同一 Wi-Fi 下手机临时访问：http://{lan_ip}:{PORT}')
print('注意：局域网 HTTP 仅用于界面测试，正式安装到 iPhone 需要 HTTPS 部署。')
print('关闭本窗口即可停止服务器。')

webbrowser.open(f'http://127.0.0.1:{PORT}')
ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
