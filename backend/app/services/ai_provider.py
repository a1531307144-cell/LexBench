"""AI Provider：OpenAI 兼容协议的 HTTP 客户端。

密钥来源仅限本地 settings 表（data/ 目录，gitignore），不进代码、不进日志、
不进异常信息。DeepSeek / 通义 / Kimi / OpenAI 等兼容接口均可使用。
"""
import httpx


class AINotConfigured(Exception):
    pass


class AICallError(Exception):
    pass


class AIProvider:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 90.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def chat(self, messages: list[dict]) -> str:
        url = f"{self.base_url}/chat/completions"
        try:
            resp = httpx.post(
                url,
                json={
                    "model": self.model,
                    "messages": messages,
                    "temperature": 0.3,
                    "stream": False,
                },
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=self.timeout,
            )
        except httpx.HTTPError as e:
            raise AICallError(f"网络请求失败：{type(e).__name__}") from e
        if resp.status_code == 401:
            raise AICallError("接口认证失败（401）：请检查 API Key 是否正确")
        if resp.status_code != 200:
            detail = resp.text[:200]
            raise AICallError(f"接口返回 {resp.status_code}：{detail}")
        try:
            return resp.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, ValueError) as e:
            raise AICallError("接口响应格式异常：未取到 choices[0].message.content") from e


def load_ai_config(conn) -> dict:
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE key IN"
        " ('ai_base_url','ai_api_key','ai_model')"
    ).fetchall()
    cfg = {r["key"]: r["value"] for r in rows}
    return {
        "base_url": cfg.get("ai_base_url", ""),
        "api_key": cfg.get("ai_api_key", ""),
        "model": cfg.get("ai_model", ""),
    }


def is_configured(cfg: dict) -> bool:
    return bool(cfg["base_url"].strip() and cfg["api_key"].strip() and cfg["model"].strip())


def build_provider(conn) -> AIProvider:
    cfg = load_ai_config(conn)
    if not is_configured(cfg):
        raise AINotConfigured("请先在「AI 设置」中填写接口地址、API Key 与模型名")
    return AIProvider(cfg["base_url"].strip(), cfg["api_key"].strip(), cfg["model"].strip())
