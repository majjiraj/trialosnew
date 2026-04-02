"""
TrialOS Embedding Client — provider-agnostic async embedding.

Configure via env vars:
    EMBEDDING_PROVIDER = openai | ollama | huggingface  (default: openai)
    EMBEDDING_MODEL    = model name (provider-specific defaults apply if unset)
    EMBEDDING_DIM      = 1536 (default; OpenAI text-embedding-3-* supports reduction)
    OLLAMA_BASE_URL    = http://localhost:11434
    OPENAI_API_KEY     = sk-...
"""
import asyncio
import os
from typing import Optional

_PROVIDER_DEFAULTS = {
    "openai":       {"model": "text-embedding-3-large", "dim": 1536, "batch_size": 2048},
    "ollama":       {"model": "nomic-embed-text",       "dim": 768,  "batch_size": 100},
    "huggingface":  {"model": "BAAI/bge-m3",            "dim": 1024, "batch_size": 100},
}


class EmbeddingClient:
    """
    Async embedding client supporting OpenAI, Ollama, and HuggingFace.

    Usage:
        client = EmbeddingClient()              # reads env vars
        vectors = await client.embed(texts)     # list[str] → list[list[float]]
        dim = client.dim                        # resolved dimension (int)
    """

    def __init__(self):
        self.provider = os.environ.get("EMBEDDING_PROVIDER", "openai").lower()
        if self.provider not in _PROVIDER_DEFAULTS:
            raise ValueError(
                f"Unknown EMBEDDING_PROVIDER '{self.provider}'. "
                f"Must be one of: {list(_PROVIDER_DEFAULTS)}"
            )

        defaults = _PROVIDER_DEFAULTS[self.provider]
        self.model: str = os.environ.get("EMBEDDING_MODEL", defaults["model"])
        self._dim: int = int(os.environ["EMBEDDING_DIM"]) if "EMBEDDING_DIM" in os.environ else defaults["dim"]
        self._batch_size: int = defaults["batch_size"]
        self._ollama_base_url: str = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

    @property
    def dim(self) -> int:
        return self._dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed a list of strings. Returns one vector per input, order preserved."""
        if not texts:
            return []
        batches = [texts[i:i + self._batch_size] for i in range(0, len(texts), self._batch_size)]
        results = await asyncio.gather(*[self._embed_batch(b) for b in batches])
        return [vec for batch_result in results for vec in batch_result]

    async def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        if self.provider == "openai":
            return await self._embed_openai(texts)
        elif self.provider == "ollama":
            return await self._embed_ollama(texts)
        elif self.provider == "huggingface":
            return await self._embed_huggingface(texts)

    # ------------------------------------------------------------------
    # OpenAI
    # ------------------------------------------------------------------

    async def _embed_openai(self, texts: list[str]) -> list[list[float]]:
        import openai
        client = openai.AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        kwargs: dict = {"model": self.model, "input": texts}
        if "EMBEDDING_DIM" in os.environ:
            # text-embedding-3-* supports dimension reduction via the dimensions param
            kwargs["dimensions"] = self._dim
        response = await client.embeddings.create(**kwargs)
        # API returns items in the same order, but sort by index to be safe
        return [item.embedding for item in sorted(response.data, key=lambda x: x.index)]

    # ------------------------------------------------------------------
    # Ollama
    # ------------------------------------------------------------------

    async def _embed_ollama(self, texts: list[str]) -> list[list[float]]:
        import httpx
        async with httpx.AsyncClient(timeout=60.0) as http:
            tasks = [
                http.post(
                    f"{self._ollama_base_url}/api/embeddings",
                    json={"model": self.model, "prompt": text},
                )
                for text in texts
            ]
            responses = await asyncio.gather(*tasks)
        results = []
        for resp in responses:
            resp.raise_for_status()
            results.append(resp.json()["embedding"])
        return results

    # ------------------------------------------------------------------
    # HuggingFace / sentence-transformers
    # ------------------------------------------------------------------

    async def _embed_huggingface(self, texts: list[str]) -> list[list[float]]:
        # sentence_transformers is sync — run in executor to avoid blocking event loop
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._hf_embed_sync, texts)

    def _hf_embed_sync(self, texts: list[str]) -> list[list[float]]:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(self.model)
        vectors = model.encode(texts, convert_to_numpy=True)
        return [v.tolist() for v in vectors]
