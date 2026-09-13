import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from adapters.hermes.client import AdapterConfig, MnemuronClient

request = json.load(sys.stdin)
target = urlsplit(request["config"]["server_url"])
assert target.scheme == "http" and target.hostname == "127.0.0.1"
client = MnemuronClient(AdapterConfig.from_mapping(request["config"]))
try:
    print(json.dumps({"result": client.remember(request["body"])}))
except Exception as error:
    print(json.dumps({"error": str(error), "operation_id": getattr(error, "operation_id", None)}))
