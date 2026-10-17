"""Shared helpers for SimpleFIN tests: fixture loading and a mock transport."""

import base64
import json
import os
from collections.abc import Callable

import httpx

from tests.conftest import FIXTURES

ACCESS_URL = "https://user123:pass456@bridge.example/simplefin"


def load_fixture() -> dict:
    with open(os.path.join(FIXTURES, "simplefin_accounts.json")) as f:
        return json.load(f)


def make_token(claim_url: str = "https://bridge.example/simplefin/claim/abc") -> str:
    return base64.b64encode(claim_url.encode()).decode()


def mock_client(
    payload: dict | Callable[[httpx.Request], httpx.Response] | None = None,
    requests: list[httpx.Request] | None = None,
) -> httpx.Client:
    body = payload if payload is not None else load_fixture()

    def handler(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        if callable(body):
            return body(request)
        return httpx.Response(200, json=body)

    return httpx.Client(transport=httpx.MockTransport(handler))
