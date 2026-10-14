"""Read-only HTTPS/authentication/read-back checks. Never invokes generation."""
import argparse
import base64
import json
import urllib.request
import urllib.error
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--credentials', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
credentials = json.loads(Path(args.credentials).read_text())
base = credentials['url']
authorization = 'Basic ' + base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
checks = []

def get(endpoint, authenticated=True):
    request = urllib.request.Request(base + endpoint, headers={'Authorization': authorization} if authenticated else {})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b''

for endpoint, authenticated, expected in [('/', False, 401), ('/codex/status', True, 200), ('/auth.json', True, 404), ('/codex-bridge.cjs', True, 404)]:
    status, content = get(endpoint, authenticated)
    checks.append({'name': endpoint + (' authenticated' if authenticated else ' unauthenticated'), 'passed': status == expected, 'status': status})
    if endpoint == '/codex/status' and status == 200:
        data = json.loads(content)
        checks.append({'name': 'cloud_chatgpt_ready', 'passed': data.get('ready') is True and data.get('auth') == 'chatgpt'})

for filename in ['index.html', 'codex-local.js', 'book-ui.js', 'book.css', 'planner-ui.js']:
    status, content = get('/' + filename)
    expected = (root / filename).read_bytes()
    if filename == 'index.html': expected = expected.replace(b'</head>', b'<script src="/cloud-config.js"></script></head>')
    checks.append({'name': 'deployed_' + filename + '_matches_workspace', 'passed': status == 200 and content == expected})

report = {'passed': all(item['passed'] for item in checks), 'checks': checks, 'origin': base}
(root / 'artifacts' / 'oracle-deployment-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
assert report['passed']
