# 0G Compute — Integration Research for ProofRelay

**Author:** research subagent · **Date:** 2026-09-02
**Method:** every number, URL, model id, package version, contract address and error string below was verified by live probe (curl / `cast` / npm registry) or read verbatim from `docs.0g.ai` raw markdown. Probes executed **2026-09-01T22:29–22:45Z**. Where I could not verify something, it is labelled **UNVERIFIED**.

**Local sources read:** `docs/ARCHITECTURE.md` §11/§17, `docs/PRD.md`, `docs/DEPLOYMENT.md`, `docs/RUNBOOK.md`, `docs/recon/RECOVERED_ABI.md`, all 42 artifacts in `/home/mdlog/Project-MDlabs/Akindo/ProofRelay/.proofrelay/storage/` (39 dirs, 84 files = 42 objects + 42 `.meta.json`).

---

## 0. Executive summary — what the repo currently gets wrong

| `.env` / `.env.example` / `DEPLOYMENT.md` today | Verified reality |
|---|---|
| `COMPUTE_MODEL=llama-3.3-70b-instruct` | **Does not exist.** The substring `llama` appears in **neither** the mainnet nor the testnet router catalog. Every request would fail. |
| `COMPUTE_BASE_URL=https://router-api.0g.ai/v1` | Correct — **but that is mainnet (chainId 16661)**. ProofRelay is deployed on **Galileo 16602**. The testnet router is `https://router-api-testnet.integratenetwork.work/v1`. |
| `COMPUTE_TIMEOUT_MS=45000` | Fine with `verify_tee` off. With `verify_tee: true` the router holds the connection **silently for up to 30 s** on top of generation — raise to ≥ 90000. |
| `@0glabs/0g-serving-broker` (candidate) | **Deprecated.** npm `description` literally reads *"DEPRECATED — renamed to `@0gfoundation/0g-compute-ts-sdk`. This package is a thin re-export shim."* |
| Docs quickstart model `zai-org/GLM-5-FP8` | **Stale in 0G's own docs.** Not in the live catalog. The catalog is keyed on canonical ids (`glm-5.2`, `glm-5.3`, …). |

**Recommended ProofRelay defaults (Galileo demo):**

```dotenv
COMPUTE_DRIVER=zerog-router
COMPUTE_BASE_URL=https://router-api-testnet.integratenetwork.work/v1
COMPUTE_MODEL=qwen2.5-omni          # the ONLY chat model on the testnet router
COMPUTE_API_KEY=sk-...              # from https://pc.testnet.0g.ai
COMPUTE_TIMEOUT_MS=90000
COMPUTE_TEMPERATURE=0
COMPUTE_SEED=1337
COMPUTE_REQUIRE_PARAMETERS=true     # hard-filter to seed-capable providers
COMPUTE_TRUST_MODE=verified         # TeeML|TeeTLS only
COMPUTE_VERIFY_TEE=true
```

Rationale is in §2.3, §4.4 and §5.

---

## 1. The 0G Compute Router

### 1.1 Base URLs — verified

| Network | chainId (verified via `eth_chainId`) | Web UI | API base | Live probe |
|---|---|---|---|---|
| **Mainnet** | `0x4115` = **16661** | `https://pc.0g.ai` (HTTP 200) | `https://router-api.0g.ai/v1` | `GET /v1/models` → **HTTP 200**, 34 060 bytes, 32 models |
| **Testnet (Galileo)** | `0x40da` = **16602** | `https://pc.testnet.0g.ai` (HTTP 200) | `https://router-api-testnet.integratenetwork.work/v1` | `GET /v1/models` → **HTTP 200**, 1 687 bytes, 2 models |

> **Trap:** `router-api-testnet.0g.ai` **does not resolve** (`curl: (6) Could not resolve host`). The testnet router genuinely lives on the third-party `integratenetwork.work` domain — do not "correct" it.
>
> ProofRelay's contract `0xc1E353cb44eA09729143f06Af97E51FB952b33D7` is on 16602, so the **testnet** router is the network-consistent choice. Balances, API keys and catalogs are fully separate between the two.

### 1.2 OpenAI compatibility — yes, fully

`POST {base}/chat/completions` (i.e. `POST https://router-api.0g.ai/v1/chat/completions`). Verbatim from `router/principles.md`:

> The Router speaks the **OpenAI API** (`/v1/chat/completions`, `/v1/images/generations`, `/v1/audio/transcriptions`, …). Same routes, same fields, same SSE format.

Accepted standard fields: `temperature`, `top_p`, `n`, `stop`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `user`, `response_format`, `tools`, `tool_choice`, `stream`, `max_tokens`, `seed`.

Two **0G-only top-level extensions**, stripped before forwarding to the provider:

| Field | Type | Meaning |
|---|---|---|
| `verify_tee` | boolean | Router synchronously verifies the provider's TEE signature; result lands in `x_0g_trace.tee_verified`. |
| `provider` | object | **Deprecated** — use `X-0G-Provider-*` headers. |

Verified public endpoints (no auth): `GET /v1/models`, `GET /v1/providers` (accepts `?model=` and `?service_type=`), `GET /v1/service-types`.
`GET /v1/models/{id}` → **404** on every id tried; there is no per-model GET. List and filter.

### 1.3 Authentication

Two credential prefixes, both in the same header shape:

```
Authorization: Bearer sk-YOUR_API_KEY          # inference — billed
Authorization: Bearer mk-YOUR_MANAGEMENT_KEY   # account/keys admin — not billed
```

Permission matrix (verbatim from `router/authentication.md`):

| Scenario | Endpoint | `sk-` | `mk-` |
|---|---|:-:|---|
| Run inference | `POST /v1/chat/completions` (etc.) | ✅ | ❌ |
| Read balance / usage / history | `GET /v1/account/*` | ❌ | ✅ `account:read` |
| List API keys | `GET /v1/api-keys` | ❌ | ✅ `keys:read` |
| Create API key | `POST /v1/api-keys` | ❌ | ✅ `keys:create` |
| Edit / revoke API key | `PATCH`/`DELETE /v1/api-keys/:id` | ❌ | ✅ `keys:manage` |
| Manage management keys | `ANY /v1/management-keys/*` | ❌ | ❌ — wallet JWT only |

> **Breaking change already shipped:** `sk-` keys **no longer** have access to `/v1/account/*`. ProofRelay's `/health` must therefore **not** try to read the balance with the inference key — it will get `403 insufficient_scope`. Use an unauthenticated `GET /v1/models` for the compute health probe (see §7.6), or issue a separate `mk-` key with `account:read`.

No OAuth, no per-request wallet signature, no session tokens on the router path.

### 1.4 Obtaining an API key — exact steps

1. Open **`https://pc.testnet.0g.ai`** (testnet) or **`https://pc.0g.ai`** (mainnet). Connect MetaMask / WalletConnect, or sign in with Google / X / Discord / TikTok via Privy (provisions an embedded wallet).
2. **Deposit 0G** — Dashboard → Deposit. This is a normal on-chain tx to the **0G Payment Layer**, a shared balance contract across all 0G products:

   | Network | Payment Layer address | Verified |
   |---|---|---|
   | Mainnet (16661) | `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` | `eth_getCode` → EIP-1967 proxy, non-empty |
   | Testnet (16602) | `0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939` | `eth_getCode` → EIP-1967 proxy → impl `0x776b1bd98d019287c86a8bc184cd457bb08157c6` |

   Funds are usable within a few seconds of confirmation. Testnet 0G from `https://faucet.0g.ai` (0.1 0G/wallet/day) or the Google Cloud faucet.
3. **Dashboard → API Keys → Create.** Label it. The full `sk-` secret is shown **once**; the dashboard stores only a hash.
4. Optionally set the key's **trust mode** to `private` at creation so *every* request from that key is forced to TeeML providers regardless of what the calling code sends. Programmatically: `POST /v1/api-keys` with `{"trust_mode":"private"}` using an `mk-` key.

**Never ship `sk-`/`mk-` to a browser.** Whoever has `sk-` spends your deposit; whoever has `mk-` mints more `sk-`. ProofRelay's workers are server-side, which is the correct place for them.

### 1.5 Complete curl example

Plain call:

```bash
curl https://router-api-testnet.integratenetwork.work/v1/chat/completions \
  -sS --max-time 90 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-YOUR_API_KEY" \
  -d '{
    "model": "qwen2.5-omni",
    "messages": [
      {"role": "system", "content": "You are a strict textual-entailment judge. Reply with JSON only."},
      {"role": "user",   "content": "PREMISE: Release v1.4.0 — August 10, 2026.\nCLAIM: The repository released version 1.4.0 on 2026-08-10.\nReturn {\"verdict\":\"SUPPORTED|CONTRADICTED|INSUFFICIENT_EVIDENCE\",\"confidence\":0.0}"}
    ],
    "temperature": 0,
    "top_p": 1,
    "seed": 1337,
    "max_tokens": 512,
    "response_format": {"type": "json_object"},
    "verify_tee": true
  }'
```

The **ProofRelay-grade** call — pinned provider, verified trust tier, hard capability filter, price ceiling:

```bash
curl https://router-api.0g.ai/v1/chat/completions \
  -sS --max-time 90 -D /tmp/headers.txt \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-YOUR_API_KEY" \
  -H "X-0G-Provider-Address: 0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0" \
  -H "X-0G-Provider-Trust-Mode: verified" \
  -H "X-0G-Provider-Require-Parameters: true" \
  -H "X-0G-Provider-Allow-Fallbacks: false" \
  -H "X-0G-Provider-Max-Price-Usd-Prompt: 2.0" \
  -H "X-0G-Provider-Max-Price-Usd-Completion: 8.0" \
  -d '{
    "model": "glm-5.3",
    "messages": [{"role":"user","content":"…"}],
    "temperature": 0, "top_p": 1, "seed": 1337,
    "response_format": {"type":"json_object"},
    "verify_tee": true
  }'
# then: grep -i 'zg-res-key\|x-ratelimit' /tmp/headers.txt
```

**Routing header reference** (verbatim from `router/routing.md`; header names are case-insensitive):

| Header | Values | Behaviour |
|---|---|---|
| `X-0G-Provider-Address` | `0x…` | Pin to one provider. **Implies `Allow-Fallbacks: false`** unless overridden. |
| `X-0G-Provider-Sort` | `latency` \| `price` | Ignored when an address is pinned. Any other non-empty value → `400 invalid_provider_header`. |
| `X-0G-Provider-Trust-Mode` | `standard` \| `verified` \| `private` | Floor, not exact match: `verified` is also satisfied by `private`. Other values → `400 invalid_trust_mode`. |
| `X-0G-Provider-Allow-Fallbacks` | `true` \| `false` | Exactly those two, case-insensitive. `1`/`yes` → `400 invalid_provider_header`. Default `true`, or `false` when an address is pinned. |
| `X-0G-Provider-Require-Parameters` | `true` \| `false` | **See §5.2 — this is the one that matters for reproducibility.** |
| `X-0G-Provider-Max-Price-Usd-Prompt` | non-negative decimal | Hard ceiling, **USD per 1 M tokens**. Filters *before* sorting and failover. |
| `X-0G-Provider-Max-Price-Usd-Completion` | non-negative decimal | idem |
| `X-0G-Provider-Max-Price-Usd-Image` | non-negative decimal | USD per generated image |

Blank/whitespace-only header = unset (never an error). Present-but-malformed = `400`.

> **Footgun I verified:** `/v1/models[].pricing_usd.prompt` is **USD per token** (e.g. `glm-5.2` = `"0.0000009"`), but `X-0G-Provider-Max-Price-Usd-Prompt` is **USD per 1 M tokens**. Multiply by 1e6 when deriving a ceiling from the catalog.

### 1.6 Response shape — `x_0g_trace`

`x_0g_trace` is present on **every** router response. This is exactly what ProofRelay should be persisting into `compute[]`:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1788289357,
  "model": "glm-5.3",
  "choices": [ { "index": 0, "message": { "role": "assistant", "content": "…", "reasoning_content": "…" }, "finish_reason": "stop" } ],
  "usage": { "prompt_tokens": 812, "completion_tokens": 96, "total_tokens": 908 },
  "x_0g_trace": {
    "request_id": "0852f405-6c56-40c2-a800-e6fd70785065",
    "provider": "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C",
    "billing": {
      "input_cost":  "19000000000000",
      "output_cost": "1916800000000000",
      "total_cost":  "1935800000000000"
    },
    "tee_verified": true
  }
}
```

| Field | Meaning |
|---|---|
| `request_id` | Unique per request. Also mirrored in the `X-Request-Id` response header (verified live) and in every error body. |
| `provider` | On-chain address of the provider that actually served it. **This is the model-pinning ground truth**, not the `model` string. |
| `billing.*` | Exact cost in **neuron** for this request. No need to compute it yourself. |
| `tee_verified` | `true` / `false` / absent — only when `verify_tee: true` was sent. |

Also useful: `ZG-Res-Key` response header carries the `chatID` needed for independent TEE verification (§5.4). Reasoning models additionally return `choices[].message.reasoning_content` (and a duplicate under `provider_specific_fields.reasoning_content`).

### 1.7 Complete TypeScript fetch example

```ts
// packages/compute-adapter/src/drivers/zerog-router.raw.ts
// Zero deps beyond Node 20 global fetch. No OpenAI SDK needed.

export interface RouterTrace {
  request_id: string;
  provider: string;
  billing?: { input_cost: string; output_cost: string; total_cost: string };
  tee_verified?: boolean | null;
}

export interface RouterChatResponse {
  id: string;
  model: string;
  created: number;
  choices: Array<{
    index: number;
    finish_reason: string;
    message: { role: 'assistant'; content: string; reasoning_content?: string };
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  x_0g_trace: RouterTrace;
}

export interface RouterError {
  error: { message: string; type: string; code: string };
  request_id?: string;
}

export interface RouterCallOptions {
  baseUrl: string;                 // e.g. https://router-api-testnet.integratenetwork.work/v1
  apiKey: string;                  // sk-…
  model: string;                   // canonical id, e.g. "qwen2.5-omni"
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  topP?: number;
  seed?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  verifyTee?: boolean;
  providerAddress?: string;        // X-0G-Provider-Address
  trustMode?: 'standard' | 'verified' | 'private';
  requireParameters?: boolean;     // hard-filter on seed/tool_choice/penalties
  allowFallbacks?: boolean;
  timeoutMs?: number;
}

export class RouterHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly type: string,
    readonly requestId: string | undefined,
    readonly retryAfterSec: number | undefined,
    message: string,
  ) { super(message); this.name = 'RouterHttpError'; }
}

export async function routerChat(opts: RouterCallOptions): Promise<{
  data: RouterChatResponse;
  chatId: string;                  // ZG-Res-Key (fallback: body id)
  rateLimit: { limit?: number; remaining?: number; reset?: string };
  latencyMs: number;
}> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
  };
  if (opts.providerAddress) headers['X-0G-Provider-Address'] = opts.providerAddress;
  if (opts.trustMode)       headers['X-0G-Provider-Trust-Mode'] = opts.trustMode;
  if (opts.requireParameters !== undefined)
    headers['X-0G-Provider-Require-Parameters'] = String(opts.requireParameters);
  if (opts.allowFallbacks !== undefined)
    headers['X-0G-Provider-Allow-Fallbacks'] = String(opts.allowFallbacks);

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.topP        !== undefined) body.top_p       = opts.topP;
  if (opts.seed        !== undefined) body.seed        = opts.seed;
  if (opts.maxTokens   !== undefined) body.max_tokens  = opts.maxTokens;
  if (opts.jsonMode)                  body.response_format = { type: 'json_object' };
  if (opts.verifyTee)                 body.verify_tee  = true;

  // verify_tee adds a silent round-trip bounded at 30s with NO keep-alive traffic.
  const timeoutMs = opts.timeoutMs ?? (opts.verifyTee ? 90_000 : 45_000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();

  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal,
    });
  } finally { clearTimeout(timer); }

  const latencyMs = Date.now() - t0;
  const rateLimit = {
    limit:     num(res.headers.get('x-ratelimit-limit-requests')),
    remaining: num(res.headers.get('x-ratelimit-remaining-requests')),
    reset:     res.headers.get('x-ratelimit-reset-requests') ?? undefined,
  };

  const raw = await res.text();

  if (!res.ok) {
    let e: RouterError | undefined;
    try { e = JSON.parse(raw) as RouterError; } catch { /* non-JSON body */ }
    throw new RouterHttpError(
      res.status,
      e?.error?.code ?? 'unknown',
      e?.error?.type ?? 'unknown',
      e?.request_id ?? res.headers.get('x-request-id') ?? undefined,
      num(res.headers.get('retry-after')),
      e?.error?.message ?? raw.slice(0, 400),
    );
  }

  const data = JSON.parse(raw) as RouterChatResponse;
  const chatId = res.headers.get('ZG-Res-Key')
              ?? res.headers.get('zg-res-key')
              ?? data.id;

  return { data, chatId, rateLimit, latencyMs };
}

const num = (v: string | null) => (v == null || v === '' ? undefined : Number(v));
```

The OpenAI SDK also works verbatim (`baseURL` + `apiKey`), but **`x_0g_trace` and `ZG-Res-Key` require raw-response access** (`client.chat.completions.with_raw_response…` in openai-node ≥ 4.x). Since ProofRelay must persist both into the report, plain `fetch` is the lower-friction choice.

---

## 2. Model ids available today

### 2.1 Mainnet — `GET https://router-api.0g.ai/v1/models` (32 models, verified 2026-09-01)

| id | type | ctx | max out | verifiability | TEE | providers | $/prompt tok | $/completion tok | formats |
|---|---|---:|---:|---|---|---:|---|---|---|
| `0gm-1.0-35b-a3b` | chatbot | 262 144 | 32 768 | **TeeML** | TDX/dstack | 1 | 0.00000008 | 0.00000048 | openai, anthropic |
| `0gm-1.0-35b-a3b-sia` | chatbot | 32 768 | 8 192 | **TeeML** | TDX | 1 | 0.000000536 | 0.000003216 | openai |
| `claude-fable-5` | chatbot | 1 000 000 | 131 072 | None | — | 1 | 0.000009 | 0.000045 | anthropic |
| `claude-opus-4-8` | chatbot | 1 000 000 | 131 072 | None | — | 2 | 0.000005 | 0.000025 | anthropic |
| `claude-opus-5` | chatbot | 1 000 000 | 128 000 | None | — | 2 | 0.000005 | 0.000025 | anthropic |
| `claude-sonnet-5` | chatbot | 1 000 000 | 131 072 | None | — | 2 | 0.0000019 | 0.0000095 | anthropic |
| `deepseek-v4-flash` | chatbot | 1 000 000 | 393 216 | TeeTLS | TDX | 2 | 0.000000138 | 0.000000275 | openai, anthropic |
| `deepseek-v4-pro` | chatbot | 1 000 000 | 393 216 | TeeTLS | TDX | 2 | 0.000001272 | 0.000003816 | openai, anthropic |
| `glm-5` | chatbot | 202 752 | 32 768 | TeeTLS | TDX | 2 | 0.00000075 | 0.0000024 | openai, anthropic |
| `glm-5.1` | chatbot | 206 848 | 131 072 | TeeTLS | TDX | 2 | 0.00000182 | 0.00000572 | openai |
| `glm-5.2` | chatbot | 1 048 576 | 131 072 | **TeeML** | TDX | 3 | 0.0000009 | 0.000003 | openai, anthropic |
| `glm-5.3` | chatbot | 1 000 000 | 131 072 | TeeTLS | TDX | 2 | 0.0000014 | 0.0000044 | openai |
| `glm-5.3-flash` | chatbot | 1 000 000 | 131 072 | TeeTLS | TDX | 2 | 0.00000011116 | 0.00000038907 | openai, anthropic |
| `hy3` | chatbot | 262 144 | 32 768 | TeeTLS | TDX | 2 | 0.000000132 | 0.000000528 | openai |
| `hy4-preview` | chatbot | 1 000 000 | 65 536 | TeeTLS | TDX | 2 | 0.000000834 | 0.000002501 | openai, anthropic |
| `kimi-k2.7-code` | chatbot | 262 144 | 16 384 | TeeTLS | TDX | 2 | 0.000001235 | 0.0000052 | openai |
| `kimi-k3` | chatbot | 1 000 000 | 131 072 | TeeTLS | TDX | 3 | 0.000003 | 0.000015 | openai |
| `minimax-m3` | chatbot | 1 000 000 | 131 072 | TeeTLS | TDX | 2 | 0.00000027 | 0.00000108 | openai |
| `gpt-5.5` | chatbot | 1 000 000 | 128 000 | None | — | 1 | 0.000005 | 0.00003 | openai |
| `gpt-5.6-luna` | chatbot | 1 000 000 | 128 000 | None | — | 1 | 0.0000002 | 0.0000012 | openai |
| `gpt-5.6-sol` | chatbot | 1 000 000 | 128 000 | None | — | 1 | 0.000005 | 0.00003 | openai |
| `gpt-5.6-terra` | chatbot | 1 000 000 | 128 000 | None | — | 1 | 0.000002 | 0.000012 | openai |
| `qwen3-vl-30b` | chatbot | 262 144 | 32 768 | TeeTLS | TDX | 2 | 0.0000000359 | 0.0000003587 | openai |
| `qwen3.6-plus` | chatbot | 1 000 000 | 65 536 | TeeTLS | TDX | 2 | 0.00000065 | 0.0000039 | openai |
| `qwen3.7-max` | chatbot | 1 000 000 | 65 536 | TeeTLS | TDX | 2 | 0.000000825 | 0.0000024755 | openai |
| `qwen3.7-plus` | chatbot | 1 000 000 | 65 536 | TeeTLS | TDX | 2 | 0.00000052 | 0.00000208 | openai |
| `qwen3.8-flash` | chatbot | 1 000 000 | 131 072 | TeeTLS | TDX | 2 | 0.000000113 | 0.000000382 | openai |
| `qwen3.8-max` | chatbot | 1 000 000 | 131 072 | TeeTLS | TDX | 2 | 0.00000165 | 0.000004951 | openai |
| `whisper-large-v3` | speech-to-text | 448 | 448 | **TeeML** | TDX | 1 | 0.00013 | 0 | openai |
| `z-image-turbo` | text-to-image | 2 048 | — | **TeeML** | TDX | 1 | 0 | 0 | openai |
| `bytedance/seedance-2.5` | video-generation | — | — | TeeTLS | TDX | 1 | 0 | 0 | openai |
| `minimax-h3` | video-generation | — | — | TeeTLS | TDX | 1 | 0 | 0 | openai |

`bytedance/seedance-2.5` and `minimax-h3` were the only providers reporting `is_healthy: false` at probe time.

### 2.2 Testnet (Galileo 16602) — `GET https://router-api-testnet.integratenetwork.work/v1/models` (2 models)

| id | type | ctx | max out | verifiability | providers | neuron/prompt tok | neuron/completion tok |
|---|---|---:|---:|---|---:|---|---|
| **`qwen2.5-omni`** | chatbot | 32 768 | 2 048 | **TeeTLS** (TDX/dstack) | 1 | `1190000000000` | `4770000000000` |
| `qwen-image-edit` | image-editing | 2 048 | — | TeeML | 1 | `0` | `0` (`image`: `5000000000000000`) |

`qwen2.5-omni` full record (live):

```json
{
  "id": "qwen2.5-omni", "object": "model", "owned_by": "0G Foundation",
  "name": "Qwen2.5-Omni", "type": "chatbot",
  "context_length": 32768, "max_completion_tokens": 2048,
  "architecture": { "modality": "text->text", "tokenizer": "qwen-bpe" },
  "supported_parameters": ["temperature","top_p","top_k","max_tokens",
                           "presence_penalty","seed","stop","stream",
                           "tools","tool_choice","response_format"],
  "supported_formats": ["openai"],
  "default_parameters": { "temperature": 0.7, "top_p": 0.8 },
  "pricing": { "prompt": "1190000000000", "completion": "4770000000000" },
  "pricing_usd": { "prompt": "0.000000175", "completion": "0.0000007" },
  "verifiability": "TeeTLS", "tee_attested": true,
  "tee_type": "TDX", "tee_verifier": "dstack", "provider_count": 1
}
```

Backing provider (from `GET /v1/providers`): `0xa48f01287233509FD694a22Bf840225062E67836`, `is_healthy: true`, uptime 100 %, latency 3 382 ms, `tee_acknowledged: true`.

### 2.3 What this means for ProofRelay

- **`qwen2.5-omni` supports `seed`.** That is a lucky and important fact — the only testnet chat model is also seed-capable, temperature-capable, and supports `response_format: json_object`. It is a viable entailment engine.
- Its ceiling is tight: **32 768 ctx / 2 048 max completion**. ProofRelay must chunk the snapshot and score claims one at a time (which the surviving reports already do — one `compute[]` entry per report, `operation: "evidence-scoring"`).
- The catalog is **live and volatile**. Do **not** hard-code the model list. `COMPUTE_MODEL` should be validated at boot against `GET /v1/models` and the process should refuse to start on a miss, with the available ids in the error message. That single check would have caught `llama-3.3-70b-instruct` immediately.

Boot-time validation:

```bash
curl -s https://router-api-testnet.integratenetwork.work/v1/models \
  | jq -r '.data[] | select(.type=="chatbot") | .id'
# → qwen2.5-omni
```

---

## 3. The direct broker SDK path

### 3.1 Package identity — verified against the npm registry

| Package | Latest | Verdict |
|---|---|---|
| **`@0gfoundation/0g-compute-ts-sdk`** | **`0.9.0`** (published 2026-07-17T11:59:00Z); `beta` → `0.9.0-beta.0`; 9 versions total | ✅ **This is the one.** `license: ISC`, `engines: {node: ">=20.0.0"}`, `main: ./lib.commonjs/index.js`, `types: ./lib.esm/index.d.ts`, `bin: { "0g-compute-cli": "cli.commonjs/cli/index.js" }`, repo `github.com/0glabs/0g-serving-user-broker` |
| `@0glabs/0g-serving-broker` | `0.7.8` (2026-04-30) | ❌ **Deprecated.** `description`: *"DEPRECATED — renamed to @0gfoundation/0g-compute-ts-sdk. This package is a thin re-export shim for backward compatibility."* Its only dependency is `@0gfoundation/0g-compute-ts-sdk: ^0.8.0`. |
| `@0gfoundation/0g-compute-cli` / `@0glabs/0g-compute-cli` | — | ❌ **404 Not found.** The CLI ships *inside* the SDK package. |
| `@0glabs/0g-ts-sdk` | `0.3.3` | (Storage SDK, different concern.) |

```bash
npm i @0gfoundation/0g-compute-ts-sdk@0.9.0 ethers@^6.13.1
# or globally, for the CLI:  npm i -g @0gfoundation/0g-compute-ts-sdk
```

Peer deps declared: `ethers ^6.13.1`, `crypto-js ^4.2.0`, `circomlibjs ^0.1.6`, `@types/crypto-js`, `@types/circomlibjs`.
Browser use needs Node polyfills (`crypto`, `stream`, `util`, `buffer`, `process`) — irrelevant for ProofRelay's server-side workers.

### 3.2 Contract addresses — read verbatim from the shipped `constants.d.ts` (v0.9.0)

```ts
export declare const TESTNET_CHAIN_ID = 16602n;
export declare const MAINNET_CHAIN_ID = 16661n;
export declare const HARDHAT_CHAIN_ID = 31337n;
export declare const CONTRACT_ADDRESSES: {
  readonly testnet:    { ledger: "0xE70830508dAc0A97e6c087c75f402f9Be669E406";
                         inference: "0xa79F4c8311FF93C06b8CfB403690cc987c93F91E";
                         fineTuning: "0xC6C075D8039763C8f1EbE580be5ADdf2fd6941bA" };
  readonly testnetDev: { ledger: "0x815B93ab4Ba4BDF530dbF1552649a3c534F8BbF7";
                         inference: "0x41bD7Ac5c19000A974D5c192bcd5FB67b56C85c5";
                         fineTuning: "0x4e4158DF35CfdC0ac63264D3E112F5B8E9a5c569" };
  readonly mainnet:    { ledger: "0x2dE54c845Cd948B72D2e32e39586fe89607074E3";
                         inference: "0x47340d900bdFec2BD393c626E12ea0656F938d84";
                         fineTuning: "0x4e3474095518883744ddf135b7E0A23301c7F9c0" };
  readonly hardhat:    { ledger: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
                         inference: "0x0165878A594ca255338adfa4d48449f69242Eb8F";
                         fineTuning: "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0" };
};
```

Note `TESTNET_CHAIN_ID = 16602n` — the SDK is already Galileo-correct, and the same chain ProofRelay is deployed on. Auto-detected from the signer's provider; overridable per-argument in `createZGComputeNetworkBroker`.

### 3.3 Live Direct-path services on Galileo — verified on-chain

```bash
cast call --rpc-url https://evmrpc-testnet.0g.ai \
  0xa79F4c8311FF93C06b8CfB403690cc987c93F91E \
  "getAllServices(uint256,uint256)((address,string,string,uint256,uint256,uint256,string,string,string,address,bool)[],uint256)" 0 50
```

`total = 6`. (`limit > 50` reverts with `LimitTooLarge(60,50)` — selector `0x062ba4db`.)

| provider | type | model | in/out price (neuron/tok) | verifiability | `teeSignerAcknowledged` |
|---|---|---|---|---|:-:|
| `0xa48f01287233509FD694a22Bf840225062E67836` | chatbot | `qwen/qwen2.5-omni-7b` | 890 000 000 000 / 3 560 000 000 000 | TeeML | **✅ true** |
| `0x4b2a941929E39Adbea5316dDF2B9Bd8Ff3134389` | image-editing | `qwen/qwen-image-edit-2511` | 0 / 5 000 000 000 000 000 | TeeML | **✅ true** |
| `0x8e60d466FD16798Bec4868aa4CE38586D5590049` | chatbot | `openai/gpt-oss-20b` | 50 000 000 000 / 100 000 000 000 | TeeML | ❌ false |
| `0x69Eb5a0BD7d0f4bF39eD5CE9Bd3376c61863aE08` | chatbot | `google/gemma-3-27b-it` | 150 000 000 000 / 400 000 000 000 | TeeML | ❌ false |
| `0x87a13337F0d4B2b08cce9189DBE9555690828ed4` | chatbot | `Qwen2.5-0.5B-Instruct` | 10 000 000 / 10 000 000 | *(empty)* | ❌ false |
| `0xA02b95Aa6886b1116C4f334eDe00381511E31A09` | chatbot | `Qwen2.5-0.5B-Instruct` | 1 000 000 000 / 1 000 000 000 | *(empty)* | ❌ false |

`lockTime()` = **86 400** (24 h refund lock), verified on-chain.

> **The broker model string is the on-chain `model` field** (`"qwen/qwen2.5-omni-7b"`), **not** the router's canonical id (`"qwen2.5-omni"`). Do not mix them up — `getServiceMetadata()` returns the correct one.
>
> Note the price discrepancy: on-chain `890000000000` prompt vs the router's `1190000000000`. Neither is wrong; the router publishes its own per-endpoint record. Never hardcode either.

For mainnet, the same call against `0x47340d900bdFec2BD393c626E12ea0656F938d84` returns 13 services (`zai-org/GLM-5-FP8`, `openai/whisper-large-v3`, `claude-opus-5`, `qwen3.7-plus`, `z-image-turbo`, `openai/gpt-oss-20b`, `openai/gpt-5.4-mini`, `glm-5.2`, `0GM-1.0-35B-A3B`, `MiniMax-H3`, `0GM-1.0-35B-A3B-SIA`, `claude-fable-5`, `dreamina-seedance-2-5-260628`).

### 3.4 Ledger / funding flow

Two-tier: **main ledger account** → **per-provider sub-accounts**.

```
wallet --deposit--> Main Account --transfer--> Provider Sub-Account --consumed--> provider
                         ^                            |
                         |------- retrieveFund --------|  (24h lock, call twice)
                         |
                    refund --> wallet
```

**Documented minimums (this is the blocker — read carefully):**

- Ledger creation (`depositFund`): **minimum 3 0G**
- Each provider sub-account: **minimum 1 0G locked** to serve requests

Against a faucet that gives **0.1 0G per wallet per day**, funding one Galileo provider sub-account takes **≈ 40 days of faucet claims**. **The Direct/broker path is effectively unusable for a testnet ProofRelay demo.** Ask in the 0G Discord for a larger testnet grant, or accept `zerog-router` / `local` for the demo and keep `zerog-broker` as a documented, tested code path.

Node.js gets **background auto-funding** (`startAutoFunding`, default 30 s poll, `bufferMultiplier` 2 → `required = unsettledFee + 2 × MIN_LOCKED_BALANCE`). Browsers do **not** (each top-up needs a wallet signature).

CLI equivalents:

```bash
0g-compute-cli setup-network
0g-compute-cli login                                      # prompts for private key
0g-compute-cli deposit --amount 10
0g-compute-cli transfer-fund --provider <ADDR> --amount 1  # also auto-acknowledges the TEE signer
0g-compute-cli get-account
0g-compute-cli get-sub-account --provider <ADDR>           # shows remaining refund lock time
0g-compute-cli retrieve-fund                               # sub-account -> main (24h lock, call twice)
0g-compute-cli refund --amount 5                           # main -> wallet
0g-compute-cli inference list-providers
0g-compute-cli inference verify --provider <ADDR>
0g-compute-cli inference get-secret --provider <ADDR>      # -> Bearer app-sk-<SECRET>
0g-compute-cli inference serve --provider <ADDR> --port 3000   # local OpenAI-compatible proxy
0g-compute-cli ui start-web --port 3090
0g-compute-cli deposit --amount 10 --gas-price 20000000000
```

**Delayed batch settlement** applies only to the Direct flow: fees accumulate and settle on-chain in batches, so a sub-account balance can drop suddenly. The Router has no such visible behaviour.

### 3.5 Provider discovery

```ts
const services = await broker.inference.listService();                 // ServiceStructOutput[]
const detailed = await broker.inference.listServiceWithDetail();       // + healthMetrics { uptime, avgResponseTime }
const chatbots = services.filter(s => s.serviceType === 'chatbot');
const { multiModel, models } = await broker.inference.getProviderModels(addr); // live /v1/models from that provider
```

`listService(offset = 0, limit = 50, includeUnacknowledged = false)` — by default it **hides** providers whose TEE signer is not acknowledged. On Galileo that means you get **2 of 6** services by default, which is the correct behaviour for ProofRelay.

No wallet required for discovery:

```ts
import { createZGComputeNetworkReadOnlyBroker } from '@0gfoundation/0g-compute-ts-sdk';
const ro = await createZGComputeNetworkReadOnlyBroker('https://evmrpc-testnet.0g.ai');
const providers = await ro.inference.listServiceWithDetail();
```

`ServiceStructOutput` fields (confirmed against the shipped typechain ABI):
`provider (address)`, `serviceType (string)`, `url (string)`, `inputPrice (uint256)`, `outputPrice (uint256)`, `updatedAt (uint256)`, `model (string)`, `verifiability (string)`, `additionalInfo (string JSON)`, `teeSignerAddress (address)`, `teeSignerAcknowledged (bool)`.

`additionalInfo` decodes to `{ VerifierURL, TargetSeparated, TEEVerifier, TargetTeeAddress, ImageName, ImageDigest, ProviderType }`.

### 3.6 Request header signing

From the shipped `request.d.ts`:

```ts
export interface ServingRequestHeaders {
  /** @deprecated */ 'X-Phala-Signature-Type'?: 'StandaloneApi';
  /** @deprecated User's address — now included in the Authorization header */ Address?: string;
  /** @deprecated */ Fee?: string;
  /** @deprecated */ 'Input-Fee'?: string;
  /** @deprecated */ 'Request-Hash'?: string;
  /** @deprecated */ Nonce?: string;
  /** @deprecated */ Signature?: string;
  Authorization: string;      // <-- the only live field
}
```

**Only `Authorization` matters now.** It is a `Bearer app-sk-<SECRET>` token derived from a wallet-signed, on-chain-revocable session token (tokenId 0–254 persistent, 255 ephemeral; revocable via `revokeApiKey` / `revokeAllTokens`). The doc's `getRequestHeaders(providerAddress, content)` second argument is `@deprecated No longer used. Kept for backward compatibility.` — **pass one argument**.

The Direct path is the correct choice for a browser dApp (user's wallet signs each request; no secret ships to the client). ProofRelay's verifier workers are server-side, so it buys nothing over the router except direct on-chain settlement receipts.

### 3.7 Complete working example (Node 20+, ESM)

```ts
// packages/compute-adapter/src/drivers/zerog-broker.example.ts
import { ethers } from 'ethers';
import {
  createZGComputeNetworkBroker,
  TESTNET_CHAIN_ID,
} from '@0gfoundation/0g-compute-ts-sdk';

const RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc-testnet.0g.ai';   // Galileo 16602

async function main() {
  // ── 1. Broker ────────────────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  if (net.chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`expected Galileo ${TESTNET_CHAIN_ID}, got ${net.chainId}`);
  }
  const wallet = new ethers.Wallet(process.env.COMPUTE_PRIVATE_KEY!, provider);
  const broker = await createZGComputeNetworkBroker(wallet);   // addresses auto-detected

  // ── 2. Ledger ────────────────────────────────────────────────────────────
  //  depositFund takes a NUMBER of 0G (not wei). Min 3 0G on first creation.
  //  transferFund takes a bigint in neuron. Min 1 0G locked per provider.
  try {
    const led = await broker.ledger.getLedger();
    console.log('ledger total  :', ethers.formatEther(led.totalBalance), '0G');
    console.log('ledger avail  :', ethers.formatEther(led.availableBalance), '0G');
  } catch {
    console.log('no ledger yet — creating with 3 0G');
    await broker.ledger.depositFund(3);
  }

  // ── 3. Discovery — acknowledged providers only (the default) ─────────────
  const services = await broker.inference.listServiceWithDetail();
  const chat = services
    .filter(s => s.serviceType === 'chatbot')
    .sort((a, b) => (a.healthMetrics?.avgResponseTime ?? 1e9)
                  - (b.healthMetrics?.avgResponseTime ?? 1e9));
  if (chat.length === 0) throw new Error('no acknowledged chatbot provider on this chain');

  const svc = chat[0];
  const providerAddress = svc.provider as string;
  console.log('provider :', providerAddress,
              '| model:', svc.model,
              '| verifiability:', svc.verifiability,
              '| uptime:', svc.healthMetrics?.uptime, '%');

  // ── 4. Optional: independent TEE attestation check ───────────────────────
  const vr = await broker.inference.verifyService(
    providerAddress,
    './.proofrelay/attestation',
    step => console.log(`  [${step.type}] ${step.message}`),
  );
  const attestationOk = !!(vr?.signerVerification?.allMatch && vr?.composeVerification?.passed);
  console.log('automated attestation checks:', attestationOk);
  // NOTE: verifyService only checks signer-address match + docker-compose hash.
  //       Full verification also needs dstack-verifier + sigstore image checks.

  // ── 5. Fund the sub-account (min 1 0G) + background auto-funding ─────────
  const [sub] = await broker.inference.getAccountWithDetail(providerAddress);
  if (sub.balance < ethers.parseEther('1')) {
    await broker.ledger.transferFund(providerAddress, 'inference', ethers.parseEther('1'));
  }
  await broker.inference.startAutoFunding(providerAddress, {
    interval: 30_000, bufferMultiplier: 2,
  });

  // ── 6. Inference ─────────────────────────────────────────────────────────
  //  endpoint === `${service.url}/v1/proxy`
  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const headers = await broker.inference.getRequestHeaders(providerAddress); // { Authorization: 'Bearer app-sk-…' }

  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a strict textual-entailment judge. Reply with JSON only.' },
      { role: 'user',   content: 'PREMISE: …\nCLAIM: …\nReturn {"verdict":…,"confidence":…}' },
    ],
    temperature: 0,
    top_p: 1,
    seed: 1337,
    max_tokens: 512,
    stream: false,
  };

  const t0 = Date.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const latencyMs = Date.now() - t0;

  if (!res.ok) throw new Error(`provider ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data: any = await res.json();

  // ── 7. TEE signature verification ────────────────────────────────────────
  //  ALWAYS prefer the ZG-Res-Key header; body id is the documented fallback.
  const chatID = res.headers.get('ZG-Res-Key')
              ?? res.headers.get('zg-res-key')
              ?? data.id
              ?? data.chatID;

  //  `content` is the usage JSON — it feeds the fee cache used by auto-funding.
  const verified = chatID
    ? await broker.inference.processResponse(
        providerAddress, chatID, JSON.stringify(data.usage ?? {}),
      )
    : null;
  //  true  -> TEE signature valid
  //  false -> INVALID: treat the response as untrusted
  //  null  -> non-verifiable service, or no chatID (verification skipped)

  console.log({
    latencyMs,
    chatID,
    verified,
    usage: data.usage,
    answer: data.choices?.[0]?.message?.content,
  });

  broker.inference.stopAutoFunding(providerAddress);
}

main().catch(e => { console.error(e); process.exit(1); });
```

Manual chat-signature verification (for a language without the SDK, or for an auditor reproducing a ProofRelay report):

```ts
// 1. read the on-chain Service record -> { url, teeSignerAddress, verifiability, additionalInfo }
//    if additionalInfo.TargetSeparated === true, the signer is additionalInfo.TargetTeeAddress
// 2. GET {url}/v1/proxy/signature/{chatID}?model={model}   ->  { text, signature }
// 3. EIP-191 personal_sign recovery:
const messageHash     = ethers.hashMessage(text);
const recoveredAddress = ethers.recoverAddress(messageHash, signature);
const isValid = recoveredAddress.toLowerCase() === signingAddress.toLowerCase();
// 4. confirm `text` matches the response content you actually received
```

Download links, if you'd rather hand an auditor a URL than a call:

```ts
await broker.inference.getSignerRaDownloadLink(providerAddress);
await broker.inference.getChatSignatureDownloadLink(providerAddress, chatID);
await broker.inference.downloadQuoteReport(providerAddress, './quote.json');
```

Starter kit (verified HTTP 200): `https://github.com/0gfoundation/0g-compute-ts-starter-kit`.

---

## 4. Pricing, free tier, rate limits

### 4.1 Unit and formula

- **neuron** is the price unit. `1e18 neuron = 1 0G`. Prices are quoted **per token**.
- `total_cost = (input_tokens × prompt_price) + (output_tokens × completion_price)`
- `input_tokens` includes the *entire* context you send (system prompt + prior messages + current message).
- **The Router adds no markup.** Catalog price = what you pay.
- You don't need to compute it: `x_0g_trace.billing.total_cost` is the exact charge in neuron for that request.
- Image/audio endpoints price per request or per second of audio.
- Cached-token tiered pricing is on the roadmap; not live.

### 4.2 Galileo testnet cost model

`qwen2.5-omni`: `1.19e12` neuron/prompt-token = `1.19e-6` 0G; `4.77e12` neuron/completion-token = `4.77e-6` 0G.

One faucet day (**0.1 0G**) buys roughly:

- **≈ 84 000 prompt tokens**, or
- **≈ 21 000 completion tokens**, or
- a realistic ProofRelay claim-scoring call at ~1 200 prompt + 200 completion tokens ⇒ `1.19e-6 × 1200 + 4.77e-6 × 200 ≈ 0.00238 0G` ⇒ **≈ 42 calls per faucet day**.

A two-verifier ProofRelay demo task with 3 claims is ~6 calls ⇒ **~7 full demo tasks per faucet day** on the router. Comfortable.

Contrast: the Direct/broker path needs **3 0G ledger + 1 0G locked** before the first token ⇒ ~40 faucet days. **Router wins on testnet.**

### 4.3 Free tier

There is **no documented free tier**. What exists (found in the router changelog at `https://0gfoundation.github.io/0g-router/`, not in the user docs):

- A **once-per-user welcome credit**, config-driven: `credit.welcome_bonus` (0G ledger) and `credit.welcome_bonus_usd` (USD ledger, *"a USD decimal, e.g. `"0.10"`; unset/`"0"` disables it, in which case no welcome is granted"*).
- Issued through an **idempotent once-per-user grant**, gated by an **IP-daily cap** and optional **Cloudflare Turnstile** verification (`action: privy_signin`). Failed/absent Turnstile **suppresses the grant** but does not block login.
- A **Project Credit Grant API** (`POST /v1/admin/project-credit-grants`, `POST /v1/project-credit-grants/distribute`) lets 0G allocate a bounded credit-subsidy envelope to a partner wallet, which the partner then distributes. Denominated in 0G or USD. **Relevant to hackathon/grant participants — worth asking 0G for.**
- Per-model **promotional (free-event) treatment** exists behind `features.model_limits` for specific models during campaigns (this is why `z-image-turbo`, `minimax-h3` and `bytedance/seedance-2.5` currently show `pricing_usd: 0`).

**Treat the welcome credit as "may or may not appear."** Do not build the demo's budget on it.

### 4.4 Rate limits

**Router — verified live:**

| Surface | Limit | Evidence |
|---|---|---|
| `GET /v1/models`, `/v1/providers`, `/v1/service-types` (public) | **120 req/min per IP** (`rate_limit.catalog_ip_rpm`) | Observed `x-ratelimit-limit-requests: 120`, `x-ratelimit-remaining-requests: 118`, `x-ratelimit-reset-requests: 2026-09-01T22:31:00Z` |
| `/status`, `/status/blockchain`, `/readyz` | 120/min per IP (`rate_limit.system_ip_rpm`) | changelog |
| `/v1/account/usage/*`, `/v1/source/*` | max **8 concurrent** per credential → `429 too_many_concurrent_requests` / `usage_query_busy` | changelog |
| Partner credit-grant endpoints | 30 RPM per account, `Retry-After ≤ 60 s` | changelog |
| **Inference (`/v1/chat/completions`)** | **Not published.** Docs: *"The exact thresholds depend on your account state and may evolve — this page documents how to observe and react to the limit, not the specific numbers."* | `router/rate-limits.md` |

Every inference response carries OpenAI-compatible headers — **read these, don't guess**:

```http
X-RateLimit-Limit-Requests: <current per-minute limit>
X-RateLimit-Remaining-Requests: <left in this window>
X-RateLimit-Reset-Requests: <ISO-8601 reset timestamp>
```

On breach: `429` immediately, with `Retry-After` in seconds.

> Roadmap (not live): per-API-key **RPM** and **TPM** budgets settable in the dashboard.

**Direct / broker path — per provider, documented:**

- **30 requests/minute** per user (sustained)
- **burst allowance of 5**
- **5 concurrent** requests per user
- Breach → provider returns `429`. *"These limits are set by individual providers and may vary."*

**Practical for ProofRelay:** two verifier workers × 3 claims sequential is trivially inside every limit. If you ever parallelise claim scoring, cap concurrency at **4** and add a token-bucket at 25 rpm to stay under the Direct-path floor regardless of driver.

---

## 5. Making inference reproducible enough for ProofRelay

Be honest in the docs about what is and isn't achievable. Nothing 0G exposes makes LLM output **bit-reproducible**. What you *can* achieve is a **fully reconstructible, cryptographically attested trace** — which is exactly what ProofRelay's PRD §6 promises (*"reproducibility over magic: setiap report harus menyebut model, prompt template, data snapshot, dan versi pipeline"*) and no more.

### 5.1 Temperature

Supported on 24 of 28 mainnet chatbots and on testnet `qwen2.5-omni`. **Not** supported on `claude-fable-5`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5`, `kimi-k3` — these advertise the Anthropic parameter set (`max_tokens`, `stream`, `system`, `stop_sequences`, `tools`, `tool_choice`, `metadata`, `output_config`, `cache_control`) and no sampling knobs at all.

Model defaults are **not** deterministic: `0gm-1.0-35b-a3b` defaults to `temperature: 1, top_k: 20, top_p: 0.95`; `glm-5`/`glm-5.1` to `0.7 / 0.9`; `qwen2.5-omni` to `0.7 / 0.8`. **Always send `temperature: 0, top_p: 1` explicitly.**

### 5.2 Seed — and the silent-fallback trap

`seed` is advertised by **12 of 28** mainnet chat models plus testnet `qwen2.5-omni`:

`deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5`, `glm-5.3`, `glm-5.3-flash`, `hy4-preview`, `qwen3-vl-30b`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.8-flash`, `qwen3.8-max` — **and `qwen2.5-omni` on testnet**.

Notably **not** advertised by: `glm-5.1`, `glm-5.2`, `hy3`, `kimi-k2.7-code`, `kimi-k3`, `minimax-m3`, `0gm-1.0-*`, all `claude-*`, all `gpt-5.*`.

**The critical behaviour**, verbatim from the router changelog:

> Unlike `tools` / `response_format` (always hard-filtered), the sampling fields are **best-effort with a soft preference by default**: the router prefers a provider that advertises the requested field and **falls back to one that doesn't (which ignores it)** only when none is available.

Two consequences ProofRelay must handle:

1. **A `seed` you send can be silently dropped.** Same request, different provider, different output, no error, no warning. Two ProofRelay verifiers could diverge for a reason invisible in the report.
2. **The fix is one header:**

   ```http
   X-0G-Provider-Require-Parameters: true
   ```

   Hard-filters to providers advertising every requested sampling/reasoning parameter. When none qualifies → `400 model_not_capable` **with the missing capability named**. Strict-by-default on the header (`true`/`false` case-insensitive; `1`/`yes` → `400 invalid_provider_header`). The body field `provider.require_parameters` is parse-lenient but deprecated.

   Also note: `frequency_penalty: 0` / `presence_penalty: 0` are treated as *omission* (they're OpenAI defaults with no effect). **`seed: 0` is still detected** as a legitimate deterministic seed. And **a pinned provider bypasses both the soft preference and the hard filter** — pinning wins, so if you pin, verify the pinned provider's `supported_parameters` yourself.

`top_k` is deliberately **not** part of capability matching (it isn't in the OpenAI schema), so you cannot rely on `top_k` routing at all.

### 5.3 Model pinning — the canonical id is not enough

A canonical id maps to **many** providers with different verifiability, trust mode, upstream, and price. Verified for `glm-5.2` via `GET /v1/providers?model=glm-5.2`:

| provider | verifiability | trust_mode |
|---|---|---|
| `0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0` | TeeTLS | verified |
| `0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D` | **TeeML** | **private** |
| `0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C` | TeeTLS | verified |

Same `model: "glm-5.2"`, three different execution environments. Round-robin across them by default.

**Three-layer pinning strategy for ProofRelay:**

| Layer | Mechanism | Effect |
|---|---|---|
| Model | `model: "qwen2.5-omni"` (validated against `/v1/models` at boot) | correct weights family |
| Trust tier | `X-0G-Provider-Trust-Mode: verified` (or `private`) | attestable execution only; ordered floor `standard < verified < private` |
| Exact endpoint | `X-0G-Provider-Address: 0x…` + `X-0G-Provider-Allow-Fallbacks: false` | one deterministic endpoint; fails rather than silently substituting |

For a **reproducible** ProofRelay run, pin all three and record `x_0g_trace.provider` in the report. For a **resilient** run (demo day), pin trust mode only and let failover work — but then the recorded `provider` is the audit anchor, not the request.

> **Cross-check to run at boot:** for the resolved `(model, provider)` pair, `GET /v1/providers?model=<id>` and assert `supported_parameters` includes `seed`. If not, either drop `seed` from the trace (don't claim what you didn't get) or pick another provider.

### 5.4 Verifiable inference / TEE attestation — what 0G actually exposes

Three verifiability modes appear in `/v1/models[].verifiability` and in the on-chain `Service.verifiability`:

| Mode | Meaning | Trust tier |
|---|---|---|
| **TeeML** | The **model itself** runs inside an Intel TDX enclave on TEE-enabled GPUs. Prompt enters encrypted, response signed inside the enclave, host sees only encrypted traffic. Neither 0G nor the hardware operator can read the data. | `private` (and satisfies `verified`) |
| **TeeTLS** | The **broker** runs in a TEE and relays to a centralised LLM over attested TLS. The broker verifies the upstream cert against trusted CAs, captures the TLS cert fingerprint, and bundles `{cert fingerprint, request hash, response hash, provider identity}` into a **signed routing proof** with its TEE key. Conceptually zkTLS-like with stronger privacy. The **upstream** still sees plaintext under its own policy. | `verified` |
| **None** / `standard` | Third-party channels. **No attestation, no signature to check.** Today the `claude-*` and `gpt-5.6-*` families. | `standard` |

All attested providers report `tee_type: "TDX"`, `tee_verifier: "dstack"`.

**Four levels of assurance, cheapest first:**

**(a) Trust-tier routing** — free, one header:

```http
X-0G-Provider-Trust-Mode: verified
```

If no provider in the tier is available, the request fails with `503 no_provider_for_trust_mode` and **never silently downgrades**:

```json
{ "error": { "message": "no provider available for trust mode: tier=private",
             "type": "server_error", "code": "no_provider_for_trust_mode" } }
```

**(b) Router-attested `verify_tee`** — one body flag, one boolean back:

```jsonc
{ "model": "qwen2.5-omni", "messages": [...], "verify_tee": true }
```
```jsonc
"x_0g_trace": { "request_id": "…", "provider": "0x…",
                "billing": {...}, "tee_verified": true }
```

| `tee_verified` | Meaning |
|---|---|
| `true` | signature validated |
| `false` | a signature was present but **did not verify — treat the response as untrusted** |
| `null` / absent | verification not requested |

Trust model, stated plainly by 0G: *"`tee_verified: true` says **the Router says it verified the signature**. It does not carry the raw signature back to you — you still have to trust the Router."*

Cost: a synchronous round-trip to the provider **bounded at 30 s with no keep-alive traffic in between**. Set the client idle timeout above 30 s. Response content and token counts are unaffected. For multipart endpoints pass it as a query param (`?verify_tee=true`) instead of a body field.

**(c) Independent verification via the SDK** — no trust in the router:

```ts
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';

// any wallet works — processResponse only reads the chain + the provider's public endpoint
const rpc    = new ethers.JsonRpcProvider('https://evmrpc-testnet.0g.ai');
const wallet = ethers.Wallet.createRandom().connect(rpc);
const broker = await createZGComputeNetworkBroker(wallet);

const res  = await fetch(`${BASE}/chat/completions`, { /* … */ });
const data = await res.json();

const providerAddress = data.x_0g_trace.provider;
const chatID          = res.headers.get('ZG-Res-Key') ?? data.id;

const isValid = await broker.inference.processResponse(providerAddress, chatID);
// true  -> independently verified
// false -> verification failed  (treat as untrusted)
// null  -> provider has no verifiable TEE service (nothing to check)
```

**This is the strongest thing ProofRelay can record**, and it works on router responses too. Because `processResponse` needs no funds and no wallet of consequence, **an adjudicator or a third-party auditor can re-run it against a stored report**. That is a genuinely novel property for the demo: *the compute claim in a ProofRelay report is independently re-verifiable by anyone, months later, from the report alone.*

**(d) Full enclave attestation** — for the provider, not the response:

```ts
const result = await broker.inference.verifyService(providerAddress, './reports', s => log(s.message));
result.signerVerification.allMatch   // contract teeSignerAddress vs attestation report
result.composeVerification.passed    // docker-compose hash: calculated vs TDX event log
result.dockerImages                  // images to check on sigstore
result.reportsData                   // { broker?, llm?, combined? } raw TDX quotes
result.outputDirectory
```

0G is explicit that this is **not** full verification: *"`verifyService` can only verify signer address and compose hash automatically. To fully verify a provider's TEE environment you must also… run dstack-verifier and check image integrity via sigstore."* The manual steps use `https://search.sigstore.dev/` and `https://github.com/Dstack-TEE/dstack` (Galileo providers pin `verifier-v0.5.4` / `v0.5.7` / `v0.5.8` in `additionalInfo.VerifierURL`).

### 5.5 What to record in the compute trace — concrete

The surviving `compute[]` entry has exactly 11 keys. Keep them, add an optional `trace` object, and **bump `schemaVersion` to `1.1.0`** (old reports keep their hashes; the consensus engine must accept both).

```jsonc
{
  // ── the 11 keys already in the artifacts, unchanged ────────────────────
  "requestId":          "0852f405-6c56-40c2-a800-e6fd70785065",
  "modelId":            "qwen2.5-omni",
  "pipelineVersion":    "0.2.0",
  "operation":          "evidence-scoring",
  "provider":           "zerog-router",
  "inputHash":          "0x1cb8883ef10d31a26376493809ed07d00f4e46e44f9b759bc679f9fc3af8fe3e",
  "outputHash":         "0xd3aec6df2c08565bceb7cbd898894fef0c32ef770c0e224ed09019ea9740205e",
  "latencyMs":          3412,
  "attempts":           1,
  "verified":           true,
  "rawArtifactPointer": "zerog://0x…",     // the raw request+response blob in 0G Storage

  // ── additive, driver-specific; absent on the `local` driver ────────────
  "trace": {
    "endpoint":          "https://router-api-testnet.integratenetwork.work/v1",
    "chainId":           16602,
    "providerAddress":   "0xa48f01287233509FD694a22Bf840225062E67836",
    "verifiability":     "TeeTLS",
    "trustMode":         "verified",
    "teeVerified":       true,          // x_0g_trace.tee_verified
    "teeIndependent":    true,          // broker.inference.processResponse(...)
    "chatId":            "chatcmpl-…",  // ZG-Res-Key — the re-verification handle
    "promptTemplateId":  "entailment/v3",
    "promptHash":        "0x…",         // keccak256 of the fully-rendered prompt
    "params":            { "temperature": 0, "top_p": 1, "seed": 1337,
                           "max_tokens": 512, "response_format": "json_object" },
    "paramsHonored":     { "seed": true, "temperature": true },  // from supported_parameters
    "requireParameters": true,
    "usage":             { "prompt_tokens": 812, "completion_tokens": 96, "total_tokens": 908 },
    "billingNeuron":     { "input": "966280000000000", "output": "457920000000000",
                           "total": "1424200000000000" },
    "snapshotHashes":    ["sha256:60be539c…", "sha256:f76d898e…"],
    "modelCatalogHash":  "0x…"          // keccak256 of the /v1/models entry, as-of
  }
}
```

`paramsHonored` and `modelCatalogHash` are the two fields that convert "we asked for `seed: 1337`" into "the endpoint that served us advertised `seed`, and here is the catalog entry proving it." That closes the silent-fallback hole from §5.2 **inside the artifact**, where an adjudicator can see it.

### 5.6 Honest limits — put this in the UI

- Even with `temperature: 0` + `seed` + a pinned provider, **byte-identical output is not guaranteed** (batching, kernel non-determinism, model hot-swaps upstream on TeeTLS).
- TeeTLS proves *"this came from the real upstream, unmodified in transit"*, **not** *"this model would produce this again"*.
- Therefore ProofRelay's consensus (ARCHITECTURE §8) is correct to score on **verdict label + evidence-source overlap + evidence quality**, not on output-string equality. Keep it that way. Reproducibility here means **the run is reconstructible and attested**, not that it is replayable to the token — say so in the UI next to the trace.

---

## 6. Failure modes, error strings, timeouts, retry policy

### 6.1 Router error envelope — verified live

```json
{
  "error": {
    "message": "Insufficient balance to process request",
    "type": "payment_error",
    "code": "insufficient_balance"
  },
  "request_id": "req_abc123"
}
```

Live captures from this machine:

```
$ POST /v1/chat/completions  (no Authorization)
HTTP/2 401
x-request-id: 918914da-fb5e-454e-840f-38bb7145e848
{"error":{"message":"Missing authorization header","type":"invalid_request_error",
          "code":"missing_authorization"},
 "request_id":"918914da-fb5e-454e-840f-38bb7145e848"}

$ POST /v1/chat/completions  -H 'Authorization: Bearer sk-bogus-key-000'
HTTP/2 401
{"error":{"message":"Invalid API key or token","type":"invalid_request_error",
          "code":"invalid_api_key"},
 "request_id":"ae6b1e61-a1fe-49c0-8371-0a4be8f35b64"}
```

Auth is checked **before** model validation — a bogus key with a bogus model still returns `invalid_api_key`. So a "wrong model" bug can hide behind an auth error during setup. Validate the key against `GET /v1/models` (public) and the model separately.

Testnet returns the identical shape with a capitalised `X-Request-Id` header.

### 6.2 HTTP status codes

| Status | Meaning |
|---|---|
| `400` | Bad request — invalid model, malformed body, unsupported feature for model |
| `401` | Missing or invalid authentication |
| `402` | Insufficient balance |
| `403` | Key lacks permission for this action |
| `404` | Resource not found |
| `429` | Rate limited — check `Retry-After` |
| `500` | Internal error |
| `502` | Provider returned an error (**failover exhausted**) |
| `503` | No healthy providers available for the requested model |

### 6.3 Error type / code catalogue

From `router/errors.md` plus codes recovered from the API reference changelog:

| `type` | `code` | Trigger |
|---|---|---|
| `invalid_request_error` | `invalid_body` | malformed JSON / schema |
| | `missing_authorization` | no `Authorization` header |
| | `invalid_api_key` | key unknown or malformed |
| | `api_key_revoked` | key revoked mid-flight; next call 401 |
| | `invalid_provider_header` | bad `X-0G-Provider-Sort` / `-Allow-Fallbacks` / `-Require-Parameters` value |
| | `invalid_trust_mode` | value not in `standard`\|`verified`\|`private` |
| | `invalid_max_price_usd` | `NaN`, `Inf`, negative, non-numeric ceiling |
| | `no_provider_within_max_price` | **400**, not 503 — pool empty *structurally*; retry won't help |
| | `pinned_provider_exceeds_max_price` | pin conflicts with the ceiling; pin is never silently overridden |
| | `model_not_capable` | `require_parameters: true` and no provider advertises the requested sampling/reasoning field (**names the missing capability**) |
| | `provider_model_mismatch` | pinned provider does not serve the requested model / service type / API format. Deterministic bad pin — retry won't help |
| `payment_error` | `insufficient_balance` | 402 |
| `permission_error` | `access_denied`, `insufficient_scope` | 403 — e.g. `sk-` hitting `/v1/account/*` |
| `not_found_error` | `api_key_not_found` | 404 |
| `rate_limit_error` | `rate_limit_exceeded` | 429, `Retry-After` ≤ 60 s |
| | `too_many_concurrent_requests`, `usage_query_busy` | 429 on usage-analytics endpoints (max 8 concurrent) |
| | `video_jobs_in_flight_limit` | 429, per-account video job cap |
| `server_error` | `no_available_provider` / `no_providers_available` | 503 |
| | `no_provider_for_trust_mode` | 503 — tier supply, transient; retry or change model |
| | `provider_error` | 502 — failover already exhausted |
| | `internal_error` | 500 |
| | `privy_unavailable` | 503 on auth surfaces |

### 6.4 Additional failure modes verified or documented

1. **Streaming errors arrive as JSON, not SSE.** With `stream: true`, when the provider refuses (rate limit, refused prompt, provider-side error), the body is `Content-Type: application/json` — an error payload, **not** an SSE stream. A strict SSE parser reports "stream opened, nothing arrived". Anthropic-format errors are always `{"type":"error","error":{"type","message"}}`. **The provider's HTTP status is relayed exactly** — 429 stays 429, 400 stays 400. Handle a non-SSE content-type on a streaming call as an error branch. (ProofRelay should use `stream: false` anyway.)
2. **`verify_tee` adds a silent ≤ 30 s gap** before the trailing trace, with no keep-alive traffic. Idle timeout must exceed 30 s + generation time.
3. **429 is now a failure signal for the circuit breaker.** A fixed bug: a provider 429 used to `MarkProviderSuccess` and re-certify a rate-limited endpoint as healthy, so cross-provider retry rotated between two views of one exhausted upstream quota (74.8 % user-visible failures in the worst case). Now 429 takes the failure arm, the breaker opens, and the independent endpoint becomes selectable. **Do not disable fallbacks unless you're deliberately pinning.**
4. **502 means failover already ran.** The router tried every healthy provider. An immediate retry is low-value but not useless (one may have just recovered).
5. **503 `no_available_provider` won't resolve in seconds.** Docs: *"consider a different model or waiting."* The router **never falls back to a different model** — model choice is yours.
6. **Direct path:** `429` (30 rpm / 5 burst / 5 concurrent), *insufficient balance* (sub-account < 1 0G), *provider not acknowledged* (fix with `transferFund`, which auto-acknowledges), *no funds in provider sub-account*.
7. **Balance lag:** router `total_balance` may trail the Payment Layer balance because the **PaymentWorker** pulls tranches in batches. `402` only fires when the router balance *and* the Payment Layer are both empty.
8. **Refund lock:** Direct-path `retrieveFund` enters a **24 h** lock (`lockTime()` = 86 400, verified on-chain) and must be called a **second time** after expiry to actually move the funds.

### 6.5 Retry policy — recommended, aligned with ARCHITECTURE §11 and RUNBOOK

ARCHITECTURE §11 already mandates *"retry maksimal tiga kali"*, then `FAILED_RETRYABLE` / `FAILED_FINAL`, and *"task tidak boleh otomatis dianggap verified"*. Here is the concrete matrix:

| Condition | Retry? | Backoff | Notes |
|---|:-:|---|---|
| `429 rate_limit_exceeded` | ✅ | **Honor `Retry-After` exactly**; if absent, 2 s → 4 s → 8 s + jitter | Never tight-loop; the router keeps returning 429 and delays your real traffic |
| `502 provider_error` | ✅ | 1 s → 2 s → 4 s + jitter | Failover exhausted; a provider may have just recovered |
| `503 no_available_provider` | ⚠️ once | 10 s, then give up | *"unlikely to resolve in seconds"* — surface to the operator |
| `503 no_provider_for_trust_mode` | ⚠️ once | 10 s | Transient tier supply. Optionally relax `private` → `verified` **only if the report records the downgrade** |
| `500 internal_error` | ✅ | 1 s → 2 s → 4 s | |
| Network / DNS / `ECONNRESET` / `AbortError` (timeout) | ✅ | 1 s → 2 s → 4 s | Treat as retryable transport |
| `400 *` | ❌ | — | Won't succeed unchanged. **`model_not_capable`, `provider_model_mismatch`, `no_provider_within_max_price`, `pinned_provider_exceeds_max_price` are all deterministic** — fail fast with an operator-readable message |
| `401 *` | ❌ | — | Key wrong or revoked |
| `402 insufficient_balance` | ❌ | — | Page the operator; RUNBOOK already lists "check the ledger balance" |
| `403 *` | ❌ | — | Wrong key kind (`sk-` on `/v1/account/*`) |
| `tee_verified === false` | ❌ | — | **Not a transport failure — a trust failure.** Do not retry; mark `verified: false`, do not use the output |

Timeouts:

| Setting | Value | Why |
|---|---|---|
| connect | 5 s | |
| read/idle, `verify_tee` **off** | 45 s | matches current `COMPUTE_TIMEOUT_MS` |
| read/idle, `verify_tee` **on** | **≥ 90 s** | the ≤ 30 s attestation gap sits on top of generation |
| whole-job budget (3 attempts) | 240 s | keeps PRD §"< 90 s for a simple 2-verifier task" achievable on the happy path |

Docs, verbatim: *"Do **not** retry `400`, `401`, `402`, or `403` without changing your request — they won't succeed."*

RUNBOOK's existing escape hatch stays correct and is the right operational answer: **`COMPUTE_DRIVER=local`, restart the workers, the trace records which driver ran.**

---

## 7. Recommended `ComputeAdapter` interface

Design constraints, in priority order:

1. **`ComputeResult` must serialise to the exact 11-key `compute[]` entry** observed in the surviving artifacts, key-for-key.
2. The `local` driver must keep producing **byte-identical** artifacts to those already in `.proofrelay/storage` (same `modelId` grammar, same `requestId` derivation, same `verified: false`, same `rawArtifactPointer: null`) so existing fixtures still hash.
3. Drivers must be swappable at runtime via `COMPUTE_DRIVER` with no call-site changes (RUNBOOK depends on this).
4. `health()` must satisfy `DependencyHealth` in `/health` as documented in RUNBOOK.

### 7.1 Observed contract from the artifacts — do not deviate

Union of keys across all 18 `compute[]` entries in 10 reports (exact, sorted):

```
attempts  inputHash  latencyMs  modelId  operation  outputHash
pipelineVersion  provider  rawArtifactPointer  requestId  verified
```

Observed values:

| Field | Observed |
|---|---|
| `operation` | `"evidence-scoring"` only (ARCHITECTURE §11 also implies `"claim-extraction"`) |
| `provider` | `"local"` only |
| `modelId` | `"local-entailment/2-0.55"` (verifier-a), `"local-entailment/3-0.62"` (verifier-b), `"local-entailment/4-0.5"` (adjudicator) → grammar `local-entailment/<topK>-<supportThreshold>` |
| `pipelineVersion` | `"0.1.0"` |
| `requestId` | `"local-" + inputHash.slice(2, 18)` — verified on all 18 entries (e.g. `inputHash 0x1cb8883ef10d31a2…` → `local-1cb8883ef10d31a2`) |
| `inputHash` / `outputHash` | `0x` + 64 hex (keccak256 over canonical JSON; distinct from `sources[].contentHash` which uses the `sha256:` prefix form) |
| `latencyMs` | integer ms (0–11 observed) |
| `attempts` | `1` |
| `verified` | `false` |
| `rawArtifactPointer` | `null` |

Cross-referenced with the verifier identities in the same reports:

| verifierId | address | modelId |
|---|---|---|
| `verifier-a` | `0x15d34aaf54267db7d7c367839aaf71a00a2c6a65` | `local-entailment/2-0.55` |
| `verifier-b` | `0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc` | `local-entailment/3-0.62` |
| `adjudicator` | `0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc` | `local-entailment/4-0.5` |

### 7.2 Types

```ts
// packages/compute-adapter/src/types.ts

export type ComputeDriverId =
  | 'local'
  | 'zerog-router'
  | 'zerog-broker'
  | 'openai-compatible';

export type ComputeOperation = 'claim-extraction' | 'evidence-scoring';

export type Verdict = 'SUPPORTED' | 'CONTRADICTED' | 'INSUFFICIENT_EVIDENCE';

/** 0x-prefixed keccak256 of canonical JSON. */
export type Hex32 = `0x${string}`;

/**
 * Exactly the 11 keys found in `compute[]` in every surviving artifact,
 * plus one additive optional `trace`. Serialise with `toComputeEntry()` —
 * never JSON.stringify this object directly.
 */
export interface ComputeResult<TOut = unknown> {
  requestId:          string;
  modelId:            string;
  pipelineVersion:    string;
  operation:          ComputeOperation;
  provider:           ComputeDriverId | 'local';
  inputHash:          Hex32;
  outputHash:         Hex32;
  latencyMs:          number;
  attempts:           number;
  verified:           boolean;
  rawArtifactPointer: string | null;

  /** schemaVersion 1.1.0+. Omitted entirely by the `local` driver. */
  trace?: ComputeTrace;

  /** In-memory only. NEVER serialised into the report. */
  output: TOut;
}

export interface ComputeTrace {
  endpoint?:          string;
  chainId?:           number;
  providerAddress?:   string;                     // x_0g_trace.provider / broker provider
  verifiability?:     'TeeML' | 'TeeTLS' | 'None';
  trustMode?:         'standard' | 'verified' | 'private';
  teeVerified?:       boolean | null;             // router-attested
  teeIndependent?:    boolean | null;             // broker.inference.processResponse
  chatId?:            string;                     // ZG-Res-Key — the re-verification handle
  promptTemplateId?:  string;
  promptHash?:        Hex32;
  params?:            Record<string, unknown>;
  paramsHonored?:     Record<string, boolean>;
  requireParameters?: boolean;
  usage?:             { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  billingNeuron?:     { input: string; output: string; total: string };
  modelCatalogHash?:  Hex32;
  errorCode?:         string;                     // last non-fatal error code seen while retrying
}

// ── operation payloads ─────────────────────────────────────────────────────

export interface ClaimExtractionInput {
  taskId:     Hex32;
  question:   string;
  answerText?: string | null;
  sources:    Array<{ sourceId: string; uri: string; contentHash: string; text: string }>;
  maxClaims:  number;
}
export interface ClaimExtractionOutput {
  claims: Array<{ claimId: string; claimText: string; origin: 'creator' | 'extracted' }>;
}

export interface EvidenceScoringInput {
  taskId:  Hex32;
  claims:  Array<{ claimId: string; claimText: string }>;
  spans:   Array<{
    snapshotObjectId: string; uri: string; contentHash: string;
    spanStart: number; spanEnd: number; text: string;
  }>;
  maxEvidencePerClaim: number;
  supportThreshold:    number;
}
export interface EvidenceScoringOutput {
  claims: Array<{
    claimId:          string;
    verdict:          Verdict;
    confidence:       number;
    reasoningSummary: string;
    sources: Array<{
      snapshotObjectId: string; uri: string; contentHash: string;
      quotedSpan: string; spanStart: number; spanEnd: number; score: number;
    }>;
  }>;
}

export interface DependencyHealth {
  ok:      boolean;
  detail:  string;                 // RUNBOOK: "…router-api.0g.ai/v1 -> HTTP 200"
  driver:  ComputeDriverId;
  modelId?: string;
  latencyMs?: number;
}

// ── the interface (ARCHITECTURE §11, extended) ─────────────────────────────

export interface ComputeAdapter {
  readonly driver:          ComputeDriverId;
  readonly modelId:         string;
  readonly pipelineVersion: string;

  runClaimExtraction(i: ClaimExtractionInput): Promise<ComputeResult<ClaimExtractionOutput>>;
  scoreEvidence(i: EvidenceScoringInput):      Promise<ComputeResult<EvidenceScoringOutput>>;
  health():                                    Promise<DependencyHealth>;

  /** Optional: re-verify a stored report's compute claim, months later. */
  reverify?(entry: SerializedComputeEntry): Promise<boolean | null>;
}

export type SerializedComputeEntry =
  Omit<ComputeResult, 'output' | 'trace'> & { trace?: ComputeTrace };

/** The ONLY way a ComputeResult reaches an artifact. Drops `output`. */
export function toComputeEntry(r: ComputeResult): SerializedComputeEntry {
  const e: SerializedComputeEntry = {
    requestId:          r.requestId,
    modelId:            r.modelId,
    pipelineVersion:    r.pipelineVersion,
    operation:          r.operation,
    provider:           r.provider,
    inputHash:          r.inputHash,
    outputHash:         r.outputHash,
    latencyMs:          r.latencyMs,
    attempts:           r.attempts,
    verified:           r.verified,
    rawArtifactPointer: r.rawArtifactPointer,
  };
  if (r.trace) e.trace = r.trace;   // omit entirely on `local` — keeps v1.0.0 hashes stable
  return e;
}
```

### 7.3 Canonical hashing (must match `packages/schemas`)

```ts
// packages/compute-adapter/src/hash.ts
import { keccak256, toUtf8Bytes } from 'ethers';
import type { Hex32 } from './types.js';

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object')                return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const body = Object.keys(o).sort()
    .filter(k => o[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',');
  return `{${body}}`;
}

export const hashCanonical = (v: unknown): Hex32 =>
  keccak256(toUtf8Bytes(canonicalJson(v))) as Hex32;

/** Verified against all 18 surviving compute entries. */
export const localRequestId = (inputHash: Hex32): string =>
  `local-${inputHash.slice(2, 18)}`;
```

> **Verify before shipping:** re-hash the inputs of a surviving artifact and confirm you reproduce its `inputHash`. If `packages/schemas` used sha256 or a different key order, this file is what changes — not the artifacts.

### 7.4 Retry / backoff shared by every network driver

```ts
// packages/compute-adapter/src/retry.ts
import { RouterHttpError } from './drivers/zerog-router.raw.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
const FATAL_CODES = new Set([
  'model_not_capable', 'provider_model_mismatch',
  'no_provider_within_max_price', 'pinned_provider_exceeds_max_price',
  'invalid_provider_header', 'invalid_trust_mode', 'invalid_max_price_usd',
  'invalid_body', 'invalid_api_key', 'api_key_revoked',
  'missing_authorization', 'insufficient_balance', 'access_denied',
  'insufficient_scope',
]);

export interface Attempted<T> { value: T; attempts: number; lastErrorCode?: string }

export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, baseMs = 1000, maxMs = 15_000 } = {},
): Promise<Attempted<T>> {
  let lastErrorCode: string | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(), attempts: attempt, lastErrorCode };
    } catch (err) {
      const e = err as RouterHttpError & { name?: string; code?: string };
      const status = e instanceof RouterHttpError ? e.status : undefined;
      const code   = e instanceof RouterHttpError ? e.code   : e.code ?? e.name;
      lastErrorCode = code;

      const transport = e.name === 'AbortError' || e.name === 'TypeError'
                     || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT'
                     || e.code === 'ENOTFOUND'  || e.code === 'EAI_AGAIN';
      const retryable = transport
        || (status !== undefined && RETRYABLE_STATUS.has(status) && !FATAL_CODES.has(code!));

      if (!retryable || attempt >= maxAttempts) throw err;

      // Honor Retry-After exactly when the router gives one.
      const retryAfterMs = (e as RouterHttpError).retryAfterSec !== undefined
        ? (e as RouterHttpError).retryAfterSec! * 1000
        : Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await new Promise(r => setTimeout(r, retryAfterMs + jitter));
    }
  }
}
```

### 7.5 Driver: `zerog-router`

```ts
// packages/compute-adapter/src/drivers/zerog-router.ts
import { routerChat, RouterHttpError, type RouterChatResponse } from './zerog-router.raw.js';
import { hashCanonical } from '../hash.js';
import { withRetry } from '../retry.js';
import type {
  ComputeAdapter, ComputeResult, ComputeTrace, DependencyHealth,
  ClaimExtractionInput, ClaimExtractionOutput,
  EvidenceScoringInput, EvidenceScoringOutput, SerializedComputeEntry,
} from '../types.js';
import { renderExtractionPrompt, renderScoringPrompt,
         parseExtraction, parseScoring } from '../prompts.js';

export interface ZeroGRouterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  chainId: number;
  pipelineVersion: string;
  temperature?: number;      // default 0
  topP?: number;             // default 1
  seed?: number;             // default 1337
  maxTokens?: number;        // default 1024
  timeoutMs?: number;        // default 90_000 with verifyTee
  verifyTee?: boolean;       // default true
  trustMode?: 'standard' | 'verified' | 'private';   // default 'verified'
  requireParameters?: boolean;                        // default true
  providerAddress?: string;  // pin (disables fallback)
  /** Optional 0G Storage put() for the raw request+response blob. */
  putRawArtifact?: (blob: unknown) => Promise<string>;
}

export class ZeroGRouterDriver implements ComputeAdapter {
  readonly driver = 'zerog-router' as const;
  get modelId()         { return this.cfg.model; }
  get pipelineVersion() { return this.cfg.pipelineVersion; }

  private catalogHash?: `0x${string}`;
  private supported = new Set<string>();

  constructor(private readonly cfg: ZeroGRouterConfig) {}

  /** Call once at boot. Fails fast on a bad COMPUTE_MODEL — the `llama-3.3` bug. */
  async init(): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/models`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`router catalog unreachable: HTTP ${res.status}`);
    const cat = await res.json() as { data: any[] };
    const m = cat.data.find(x => x.id === this.cfg.model);
    if (!m) {
      const chat = cat.data.filter(x => x.type === 'chatbot').map(x => x.id).join(', ');
      throw new Error(
        `COMPUTE_MODEL="${this.cfg.model}" is not in the catalog at ${this.cfg.baseUrl}. ` +
        `Available chatbot models: ${chat || '(none)'}`,
      );
    }
    this.catalogHash = hashCanonical(m);
    this.supported = new Set<string>(m.supported_parameters ?? []);
    if (this.cfg.seed !== undefined && !this.supported.has('seed')) {
      // Not fatal: require_parameters may still find a provider that does.
      console.warn(
        `[compute] model "${this.cfg.model}" does not advertise "seed"; ` +
        `relying on X-0G-Provider-Require-Parameters=${this.cfg.requireParameters ?? true}`,
      );
    }
  }

  async runClaimExtraction(input: ClaimExtractionInput) {
    return this.call('claim-extraction', input,
      renderExtractionPrompt(input), parseExtraction) as Promise<ComputeResult<ClaimExtractionOutput>>;
  }

  async scoreEvidence(input: EvidenceScoringInput) {
    return this.call('evidence-scoring', input,
      renderScoringPrompt(input), parseScoring) as Promise<ComputeResult<EvidenceScoringOutput>>;
  }

  private async call<TIn, TOut>(
    operation: 'claim-extraction' | 'evidence-scoring',
    input: TIn,
    prompt: { templateId: string; system: string; user: string },
    parse: (raw: string) => TOut,
  ): Promise<ComputeResult<TOut>> {
    const inputHash  = hashCanonical(input);
    const promptHash = hashCanonical({ s: prompt.system, u: prompt.user });

    const params = {
      temperature: this.cfg.temperature ?? 0,
      top_p:       this.cfg.topP        ?? 1,
      seed:        this.cfg.seed        ?? 1337,
      max_tokens:  this.cfg.maxTokens   ?? 1024,
      response_format: 'json_object',
    };

    let totalLatency = 0;
    const { value, attempts, lastErrorCode } = await withRetry(async () => {
      const r = await routerChat({
        baseUrl: this.cfg.baseUrl,
        apiKey:  this.cfg.apiKey,
        model:   this.cfg.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user',   content: prompt.user },
        ],
        temperature: params.temperature,
        topP:        params.top_p,
        seed:        params.seed,
        maxTokens:   params.max_tokens,
        jsonMode:    true,
        verifyTee:         this.cfg.verifyTee ?? true,
        trustMode:         this.cfg.trustMode ?? 'verified',
        requireParameters: this.cfg.requireParameters ?? true,
        providerAddress:   this.cfg.providerAddress,
        allowFallbacks:    this.cfg.providerAddress ? false : undefined,
        timeoutMs:         this.cfg.timeoutMs ?? 90_000,
      });
      totalLatency += r.latencyMs;
      return r;
    });

    const data: RouterChatResponse = value.data;
    const tr = data.x_0g_trace;

    // A signature that was present and did NOT verify is a trust failure, not a retry.
    if (tr?.tee_verified === false) {
      throw new RouterHttpError(200, 'tee_unverified', 'trust_error', tr.request_id,
        undefined, 'provider TEE signature present but did not verify');
    }

    const content = data.choices?.[0]?.message?.content ?? '';
    const output  = parse(content);

    const rawArtifactPointer = this.cfg.putRawArtifact
      ? await this.cfg.putRawArtifact({
          request: { model: this.cfg.model, params, prompt },
          response: data,
        })
      : null;

    const trace: ComputeTrace = {
      endpoint:          this.cfg.baseUrl,
      chainId:           this.cfg.chainId,
      providerAddress:   tr?.provider,
      trustMode:         this.cfg.trustMode ?? 'verified',
      teeVerified:       tr?.tee_verified ?? null,
      chatId:            value.chatId,
      promptTemplateId:  prompt.templateId,
      promptHash,
      params,
      paramsHonored: {
        seed:        this.supported.has('seed'),
        temperature: this.supported.has('temperature'),
        top_p:       this.supported.has('top_p'),
      },
      requireParameters: this.cfg.requireParameters ?? true,
      usage: data.usage,
      billingNeuron: tr?.billing && {
        input: tr.billing.input_cost, output: tr.billing.output_cost, total: tr.billing.total_cost,
      },
      modelCatalogHash: this.catalogHash,
      errorCode: lastErrorCode,
    };

    return {
      requestId:       tr?.request_id ?? data.id,
      modelId:         this.cfg.model,
      pipelineVersion: this.cfg.pipelineVersion,
      operation,
      provider:        'zerog-router',
      inputHash,
      outputHash:      hashCanonical(output),
      latencyMs:       totalLatency,
      attempts,
      verified:        tr?.tee_verified === true,
      rawArtifactPointer,
      trace,
      output,
    };
  }

  async health(): Promise<DependencyHealth> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/models`;
    const t0 = Date.now();
    try {
      // Public + unauthenticated: a `sk-` key would get 403 on /v1/account/*.
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return { ok: false, driver: this.driver, modelId: this.cfg.model, latencyMs,
                 detail: `${host(url)} -> HTTP ${res.status}` };
      }
      const cat = await res.json() as { data: any[] };
      const present = cat.data.some(m => m.id === this.cfg.model);
      return {
        ok: present, driver: this.driver, modelId: this.cfg.model, latencyMs,
        detail: present
          ? `${host(url)} -> HTTP 200 (${cat.data.length} models, "${this.cfg.model}" present)`
          : `${host(url)} -> HTTP 200 but model "${this.cfg.model}" is NOT in the catalog`,
      };
    } catch (e) {
      return { ok: false, driver: this.driver, modelId: this.cfg.model,
               detail: `${host(url)} -> ${(e as Error).message}` };
    }
  }

  /** Re-verify a stored report's compute claim without any funds. */
  async reverify(entry: SerializedComputeEntry): Promise<boolean | null> {
    const { providerAddress, chatId } = entry.trace ?? {};
    if (!providerAddress || !chatId) return null;
    const { ethers } = await import('ethers');
    const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk');
    const rpc = new ethers.JsonRpcProvider(process.env.OG_RPC_URL!);
    const broker = await createZGComputeNetworkBroker(ethers.Wallet.createRandom().connect(rpc));
    return broker.inference.processResponse(providerAddress, chatId);
  }
}

const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
```

### 7.6 Driver: `zerog-broker`

```ts
// packages/compute-adapter/src/drivers/zerog-broker.ts
import { ethers } from 'ethers';
import {
  createZGComputeNetworkBroker, TESTNET_CHAIN_ID, MAINNET_CHAIN_ID,
  type ZGComputeNetworkBroker,
} from '@0gfoundation/0g-compute-ts-sdk';
import { hashCanonical } from '../hash.js';
import { withRetry } from '../retry.js';
import type { ComputeAdapter, ComputeResult, DependencyHealth,
              SerializedComputeEntry } from '../types.js';

export interface ZeroGBrokerConfig {
  rpcUrl: string;                    // https://evmrpc-testnet.0g.ai  (Galileo 16602)
  privateKey: string;
  pipelineVersion: string;
  providerAddress?: string;          // omit -> lowest-latency acknowledged chatbot
  minSubAccount?: bigint;            // default 1 0G — the documented provider minimum
  ledgerMinDeposit?: number;         // default 3   — the documented ledger minimum
  temperature?: number; topP?: number; seed?: number; maxTokens?: number;
  timeoutMs?: number;                // default 60_000
  autoFundIntervalMs?: number;       // default 30_000
  putRawArtifact?: (blob: unknown) => Promise<string>;
}

export class ZeroGBrokerDriver implements ComputeAdapter {
  readonly driver = 'zerog-broker' as const;
  get modelId()         { return this.resolvedModel ?? '(uninitialised)'; }
  get pipelineVersion() { return this.cfg.pipelineVersion; }

  private broker!: ZGComputeNetworkBroker;
  private providerAddress!: string;
  private endpoint!: string;             // `${service.url}/v1/proxy`
  private resolvedModel?: string;        // on-chain model string, e.g. "qwen/qwen2.5-omni-7b"
  private verifiability?: string;
  private chainId!: number;

  constructor(private readonly cfg: ZeroGBrokerConfig) {}

  async init(): Promise<void> {
    const provider = new ethers.JsonRpcProvider(this.cfg.rpcUrl);
    const net = await provider.getNetwork();
    this.chainId = Number(net.chainId);
    if (net.chainId !== TESTNET_CHAIN_ID && net.chainId !== MAINNET_CHAIN_ID) {
      throw new Error(`unsupported chainId ${net.chainId}; expected ` +
                      `${TESTNET_CHAIN_ID} (Galileo) or ${MAINNET_CHAIN_ID} (mainnet)`);
    }
    const wallet = new ethers.Wallet(this.cfg.privateKey, provider);
    this.broker = await createZGComputeNetworkBroker(wallet);

    // Ledger: 3 0G minimum on creation.
    try { await this.broker.ledger.getLedger(); }
    catch { await this.broker.ledger.depositFund(this.cfg.ledgerMinDeposit ?? 3); }

    // Discovery — acknowledged providers only (listService default).
    const services = await this.broker.inference.listServiceWithDetail();
    const chat = services
      .filter(s => s.serviceType === 'chatbot')
      .sort((a, b) => (a.healthMetrics?.avgResponseTime ?? 1e9)
                    - (b.healthMetrics?.avgResponseTime ?? 1e9));
    const svc = this.cfg.providerAddress
      ? chat.find(s => (s.provider as string).toLowerCase() === this.cfg.providerAddress!.toLowerCase())
      : chat[0];
    if (!svc) throw new Error(`no acknowledged chatbot provider on chain ${this.chainId}`);

    this.providerAddress = svc.provider as string;
    this.verifiability   = (svc.verifiability as string) || 'None';

    // Sub-account: 1 0G minimum locked. transferFund also auto-acknowledges the TEE signer.
    const min = this.cfg.minSubAccount ?? ethers.parseEther('1');
    const [sub] = await this.broker.inference.getAccountWithDetail(this.providerAddress);
    if (sub.balance < min) {
      await this.broker.ledger.transferFund(this.providerAddress, 'inference', min);
    }
    await this.broker.inference.startAutoFunding(this.providerAddress, {
      interval: this.cfg.autoFundIntervalMs ?? 30_000, bufferMultiplier: 2,
    });

    const meta = await this.broker.inference.getServiceMetadata(this.providerAddress);
    this.endpoint      = meta.endpoint;
    this.resolvedModel = meta.model;
  }

  async close() { this.broker?.inference.stopAutoFunding(this.providerAddress); }

  // runClaimExtraction / scoreEvidence delegate to `call`, identical in shape to the router driver.

  private async call<TIn, TOut>(
    operation: 'claim-extraction' | 'evidence-scoring',
    input: TIn,
    prompt: { templateId: string; system: string; user: string },
    parse: (raw: string) => TOut,
  ): Promise<ComputeResult<TOut>> {
    const inputHash  = hashCanonical(input);
    const promptHash = hashCanonical({ s: prompt.system, u: prompt.user });
    const params = {
      temperature: this.cfg.temperature ?? 0,
      top_p:       this.cfg.topP        ?? 1,
      seed:        this.cfg.seed        ?? 1337,
      max_tokens:  this.cfg.maxTokens   ?? 1024,
    };

    let totalLatency = 0;
    const { value, attempts, lastErrorCode } = await withRetry(async () => {
      // Headers are single-use: regenerate on EVERY attempt (replay protection).
      const headers = await this.broker.inference.getRequestHeaders(this.providerAddress);
      const t0 = Date.now();
      const res = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          model: this.resolvedModel,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user',   content: prompt.user },
          ],
          ...params,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000),
      });
      totalLatency += Date.now() - t0;
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`provider ${res.status}: ${body.slice(0, 300)}`) as Error & { code?: string };
        err.code = res.status === 429 ? 'rate_limit_exceeded' : `http_${res.status}`;
        throw err;
      }
      const data: any = await res.json();
      const chatId = res.headers.get('ZG-Res-Key') ?? res.headers.get('zg-res-key')
                  ?? data.id ?? data.chatID;
      return { data, chatId };
    });

    // TEE signature verification. `content` (usage JSON) feeds the fee cache.
    const teeIndependent = value.chatId
      ? await this.broker.inference.processResponse(
          this.providerAddress, value.chatId, JSON.stringify(value.data.usage ?? {}),
        )
      : null;
    if (teeIndependent === false) {
      throw Object.assign(new Error('TEE signature verification FAILED'), { code: 'tee_unverified' });
    }

    const output = parse(value.data.choices?.[0]?.message?.content ?? '');
    const rawArtifactPointer = this.cfg.putRawArtifact
      ? await this.cfg.putRawArtifact({ request: { model: this.resolvedModel, params, prompt },
                                        response: value.data })
      : null;

    return {
      requestId:       value.chatId ?? value.data.id,
      modelId:         this.resolvedModel!,
      pipelineVersion: this.cfg.pipelineVersion,
      operation,
      provider:        'zerog-broker',
      inputHash,
      outputHash:      hashCanonical(output),
      latencyMs:       totalLatency,
      attempts,
      verified:        teeIndependent === true,
      rawArtifactPointer,
      trace: {
        endpoint:         this.endpoint,
        chainId:          this.chainId,
        providerAddress:  this.providerAddress,
        verifiability:    this.verifiability as any,
        teeIndependent,
        chatId:           value.chatId,
        promptTemplateId: prompt.templateId,
        promptHash,
        params,
        usage:            value.data.usage,
        errorCode:        lastErrorCode,
      },
      output,
    };
  }

  async health(): Promise<DependencyHealth> {
    try {
      const [sub] = await this.broker.inference.getAccountWithDetail(this.providerAddress);
      const min = this.cfg.minSubAccount ?? ethers.parseEther('1');
      const ok = sub.balance >= min;
      return {
        ok, driver: this.driver, modelId: this.resolvedModel,
        detail: `provider ${this.providerAddress.slice(0, 10)}… sub-account ` +
                `${ethers.formatEther(sub.balance)} 0G (min ${ethers.formatEther(min)})`,
      };
    } catch (e) {
      return { ok: false, driver: this.driver, detail: (e as Error).message };
    }
  }

  async reverify(entry: SerializedComputeEntry): Promise<boolean | null> {
    const { providerAddress, chatId } = entry.trace ?? {};
    if (!providerAddress || !chatId) return null;
    return this.broker.inference.processResponse(providerAddress, chatId);
  }
}
```

### 7.7 Driver: `local` (deterministic offline entailment)

Must reproduce the surviving artifacts exactly. Note `verified: false`, `rawArtifactPointer: null`, **no `trace`**.

```ts
// packages/compute-adapter/src/drivers/local.ts
import { hashCanonical, localRequestId } from '../hash.js';
import type { ComputeAdapter, ComputeResult, DependencyHealth,
              EvidenceScoringInput, EvidenceScoringOutput,
              ClaimExtractionInput, ClaimExtractionOutput, Verdict } from '../types.js';

export interface LocalConfig {
  /** Evidence spans kept per claim. Observed: 2 (verifier-a), 3 (verifier-b), 4 (adjudicator). */
  topK: number;
  /** Support threshold. Observed: 0.55, 0.62, 0.5. */
  supportThreshold: number;
  /** Observed "0.1.0" in every surviving artifact. */
  pipelineVersion: string;
}

/** `local-entailment/<topK>-<supportThreshold>` — verified against all 10 reports. */
const localModelId = (c: LocalConfig) => `local-entailment/${c.topK}-${c.supportThreshold}`;

export class LocalDriver implements ComputeAdapter {
  readonly driver = 'local' as const;
  get modelId()         { return localModelId(this.cfg); }
  get pipelineVersion() { return this.cfg.pipelineVersion; }

  constructor(private readonly cfg: LocalConfig) {}

  async scoreEvidence(input: EvidenceScoringInput): Promise<ComputeResult<EvidenceScoringOutput>> {
    const inputHash = hashCanonical(input);
    const t0 = Date.now();

    // Deterministic lexical entailment: token-overlap Jaccard-ish score, no RNG,
    // no clock, no locale — same input => same output, forever.
    const claims = input.claims.map(c => {
      const scored = input.spans
        .map(s => ({ span: s, score: overlapScore(c.claimText, s.text) }))
        .sort((a, b) => b.score - a.score || cmp(a.span.snapshotObjectId, b.span.snapshotObjectId))
        .slice(0, this.cfg.topK);

      const best = scored[0]?.score ?? 0;
      const negated = scored[0] ? contradicts(c.claimText, scored[0].span.text) : false;

      const verdict: Verdict =
        negated                       ? 'CONTRADICTED'
        : best >= this.cfg.supportThreshold ? 'SUPPORTED'
        :                               'INSUFFICIENT_EVIDENCE';

      return {
        claimId:    c.claimId,
        verdict,
        confidence: round4(calibrate(best, verdict, this.cfg.supportThreshold)),
        reasoningSummary: verdict === 'INSUFFICIENT_EVIDENCE'
          ? `The closest span (score ${round2(best)}) is below this pipeline's support ` +
            `threshold of ${this.cfg.supportThreshold}, so the claim is not established by the snapshot.`
          : `The quoted span states the claim directly (score ${round2(best)}).`,
        sources: scored.map(({ span, score }) => ({
          snapshotObjectId: span.snapshotObjectId,
          uri:              span.uri,
          contentHash:      span.contentHash,
          quotedSpan:       span.text,
          spanStart:        span.spanStart,
          spanEnd:          span.spanEnd,
          score,                       // full float precision, as in the artifacts
        })),
      };
    });

    const output: EvidenceScoringOutput = { claims };
    return {
      requestId:          localRequestId(inputHash),   // "local-" + inputHash[2..18]
      modelId:            this.modelId,
      pipelineVersion:    this.cfg.pipelineVersion,
      operation:          'evidence-scoring',
      provider:           'local',
      inputHash,
      outputHash:         hashCanonical(output),
      latencyMs:          Date.now() - t0,
      attempts:           1,
      verified:           false,
      rawArtifactPointer: null,
      // no `trace` — keeps schemaVersion 1.0.0 hashes byte-stable
      output,
    };
  }

  async runClaimExtraction(input: ClaimExtractionInput): Promise<ComputeResult<ClaimExtractionOutput>> {
    /* deterministic sentence splitter + filter; same envelope as above */
    throw new Error('not shown');
  }

  async health(): Promise<DependencyHealth> {
    return { ok: true, driver: 'local', modelId: this.modelId,
             detail: 'deterministic offline entailment engine (no network)' };
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;   // artifacts show 4dp: 0.4364, 0.7179
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
declare function overlapScore(claim: string, span: string): number;
declare function contradicts(claim: string, span: string): boolean;
declare function calibrate(score: number, v: Verdict, threshold: number): number;
```

`confidence` in the artifacts is rounded to 4 dp (`0.4364`, `0.7179`, `0.9700`) while `sources[].score` keeps full float precision (`0.5590909090909091`). Preserve both conventions exactly, or existing report hashes break.

### 7.8 Driver: `openai-compatible`

Escape hatch for local Ollama / vLLM / any OpenAI-shaped endpoint. Identical to `zerog-router` minus the 0G extensions.

```ts
// packages/compute-adapter/src/drivers/openai-compatible.ts
export interface OpenAICompatibleConfig {
  baseUrl: string;                          // e.g. http://localhost:11434/v1
  apiKey?: string;                          // optional; omit the header when unset
  model: string;
  pipelineVersion: string;
  temperature?: number; topP?: number; seed?: number; maxTokens?: number;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  putRawArtifact?: (blob: unknown) => Promise<string>;
}
```

Behavioural deltas from `zerog-router`, all of which must be reflected in the artifact:

| Aspect | Difference |
|---|---|
| `provider` | `'openai-compatible'` |
| `requestId` | body `id` (no `x_0g_trace`) |
| `verified` | **always `false`** — there is no attestation. Never claim otherwise. |
| `trace.teeVerified` / `teeIndependent` | omitted |
| `trace.endpoint` | the configured `baseUrl`, so an auditor can see this was not 0G |
| routing headers | never sent |
| `reverify()` | not implemented — returns `null` |

Guard rail worth adding: refuse to start with `driver === 'openai-compatible'` when `NODE_ENV === 'production'` unless `ALLOW_NON_ZEROG_COMPUTE=1`. The PRD's FR-08 requires 0G Compute for extraction/scoring; a silently non-0G run would invalidate the submission.

### 7.9 Factory + wiring

```ts
// packages/compute-adapter/src/index.ts
import { LocalDriver }            from './drivers/local.js';
import { ZeroGRouterDriver }      from './drivers/zerog-router.js';
import { ZeroGBrokerDriver }      from './drivers/zerog-broker.js';
import { OpenAICompatibleDriver } from './drivers/openai-compatible.js';
import type { ComputeAdapter, ComputeDriverId } from './types.js';

export * from './types.js';
export { toComputeEntry } from './types.js';
export { canonicalJson, hashCanonical, localRequestId } from './hash.js';

const PIPELINE_VERSION = '0.2.0';   // bump whenever prompts or scoring change

export async function createComputeAdapter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ComputeAdapter> {
  const driver = (env.COMPUTE_DRIVER ?? 'local') as ComputeDriverId;

  switch (driver) {
    case 'local':
      return new LocalDriver({
        topK:             Number(env.COMPUTE_LOCAL_TOPK      ?? 3),
        supportThreshold: Number(env.COMPUTE_LOCAL_THRESHOLD ?? 0.62),
        pipelineVersion:  env.COMPUTE_PIPELINE_VERSION ?? '0.1.0',   // keep 0.1.0 for fixtures
      });

    case 'zerog-router': {
      const d = new ZeroGRouterDriver({
        baseUrl:  req(env, 'COMPUTE_BASE_URL'),
        apiKey:   req(env, 'COMPUTE_API_KEY'),
        model:    req(env, 'COMPUTE_MODEL'),
        chainId:  Number(env.CHAIN_ID ?? 16602),
        pipelineVersion:   env.COMPUTE_PIPELINE_VERSION ?? PIPELINE_VERSION,
        temperature:       num(env.COMPUTE_TEMPERATURE) ?? 0,
        topP:              num(env.COMPUTE_TOP_P)       ?? 1,
        seed:              num(env.COMPUTE_SEED)        ?? 1337,
        maxTokens:         num(env.COMPUTE_MAX_TOKENS)  ?? 1024,
        timeoutMs:         num(env.COMPUTE_TIMEOUT_MS)  ?? 90_000,
        verifyTee:         env.COMPUTE_VERIFY_TEE !== 'false',
        trustMode:        (env.COMPUTE_TRUST_MODE as any) ?? 'verified',
        requireParameters: env.COMPUTE_REQUIRE_PARAMETERS !== 'false',
        providerAddress:   env.COMPUTE_PROVIDER_ADDRESS || undefined,
      });
      await d.init();                       // fails fast on a bad COMPUTE_MODEL
      return d;
    }

    case 'zerog-broker': {
      const d = new ZeroGBrokerDriver({
        rpcUrl:          req(env, 'OG_RPC_URL'),
        privateKey:      req(env, 'COMPUTE_PRIVATE_KEY'),
        pipelineVersion: env.COMPUTE_PIPELINE_VERSION ?? PIPELINE_VERSION,
        providerAddress: env.COMPUTE_PROVIDER_ADDRESS || undefined,
        temperature: num(env.COMPUTE_TEMPERATURE) ?? 0,
        topP:        num(env.COMPUTE_TOP_P)       ?? 1,
        seed:        num(env.COMPUTE_SEED)        ?? 1337,
        maxTokens:   num(env.COMPUTE_MAX_TOKENS)  ?? 1024,
        timeoutMs:   num(env.COMPUTE_TIMEOUT_MS)  ?? 60_000,
      });
      await d.init();
      return d;
    }

    case 'openai-compatible': {
      if (env.NODE_ENV === 'production' && env.ALLOW_NON_ZEROG_COMPUTE !== '1') {
        throw new Error('openai-compatible is not a 0G driver; set ALLOW_NON_ZEROG_COMPUTE=1 to override');
      }
      return new OpenAICompatibleDriver({
        baseUrl: req(env, 'COMPUTE_BASE_URL'),
        apiKey:  env.COMPUTE_API_KEY,
        model:   req(env, 'COMPUTE_MODEL'),
        pipelineVersion: env.COMPUTE_PIPELINE_VERSION ?? PIPELINE_VERSION,
        timeoutMs: num(env.COMPUTE_TIMEOUT_MS) ?? 45_000,
      });
    }

    default:
      throw new Error(
        `unknown COMPUTE_DRIVER="${driver}"; expected one of: ` +
        `local, zerog-router, zerog-broker, openai-compatible`,
      );
  }
}

const req = (e: NodeJS.ProcessEnv, k: string) => {
  const v = e[k];
  if (!v) throw new Error(`${k} is required for COMPUTE_DRIVER=${e.COMPUTE_DRIVER}`);
  return v;
};
const num = (v?: string) => (v == null || v === '' ? undefined : Number(v));
```

Worker call site is driver-agnostic and preserves the exact artifact shape:

```ts
// workers/verifier/src/main.ts (excerpt)
import { createComputeAdapter, toComputeEntry } from '@proofrelay/compute-adapter';

const compute = await createComputeAdapter();
const result  = await compute.scoreEvidence(scoringInput);

report.compute = [toComputeEntry(result)];       // <- exactly the 11 keys (+ optional trace)
report.verifier.modelId         = result.modelId;
report.verifier.pipelineVersion = result.pipelineVersion;
report.claims                   = buildClaims(result.output);
```

### 7.10 Corrected `.env` block

```dotenv
# ─── 0G Compute ───────────────────────────────────────────────────────────────
# local             = deterministic offline entailment engine (no network, no funds)
# zerog-router      = 0G Compute Router, OpenAI-compatible; API key from pc.0g.ai /
#                     pc.testnet.0g.ai. RECOMMENDED for the Galileo demo.
# zerog-broker      = direct provider via @0gfoundation/0g-compute-ts-sdk@0.9.0.
#                     Needs 3 0G ledger + 1 0G per provider sub-account —
#                     ~40 days of the 0.1 0G/day faucet. Not practical on testnet.
# openai-compatible = any OpenAI-shaped endpoint. NOT 0G; `verified` is always false.
COMPUTE_DRIVER=zerog-router

# --- zerog-router -------------------------------------------------------------
# Galileo (16602) — matches the deployed ProofRelay contract:
COMPUTE_BASE_URL=https://router-api-testnet.integratenetwork.work/v1
# Mainnet (16661):  https://router-api.0g.ai/v1
COMPUTE_API_KEY=sk-...                     # pc.testnet.0g.ai -> Dashboard -> API Keys
# Validated against GET /v1/models at boot. The testnet router serves exactly one
# chatbot model today; verify before every demo:
#   curl -s $COMPUTE_BASE_URL/models | jq -r '.data[]|select(.type=="chatbot")|.id'
COMPUTE_MODEL=qwen2.5-omni
COMPUTE_TEMPERATURE=0
COMPUTE_TOP_P=1
COMPUTE_SEED=1337
COMPUTE_MAX_TOKENS=1024
# verify_tee holds the connection for up to 30s with no keep-alive traffic.
COMPUTE_TIMEOUT_MS=90000
COMPUTE_VERIFY_TEE=true
COMPUTE_TRUST_MODE=verified                # standard | verified | private
# Without this the router SILENTLY falls back to a provider that ignores `seed`.
COMPUTE_REQUIRE_PARAMETERS=true
# COMPUTE_PROVIDER_ADDRESS=0xa48f01287233509FD694a22Bf840225062E67836   # pin; disables fallback

# --- zerog-broker -------------------------------------------------------------
COMPUTE_PRIVATE_KEY=0x...                  # funds the compute ledger (3 0G min)
# OG_RPC_URL=https://evmrpc-testnet.0g.ai  # chainId 16602 (verified)

# --- local --------------------------------------------------------------------
COMPUTE_LOCAL_TOPK=3                       # a=2  b=3  adjudicator=4
COMPUTE_LOCAL_THRESHOLD=0.62               # a=0.55  b=0.62  adjudicator=0.5
COMPUTE_PIPELINE_VERSION=0.1.0             # keep 0.1.0 to preserve fixture hashes
```

---

## 8. Open items and unverified claims

| Item | Status |
|---|---|
| Per-account **inference** RPM/TPM on the router | **UNVERIFIED — not published.** Read `X-RateLimit-*` at runtime. Roadmap: dashboard-settable RPM/TPM. |
| Exact welcome-credit amount currently configured | **UNVERIFIED.** Config-driven (`credit.welcome_bonus`, `credit.welcome_bonus_usd`, docs example `"0.10"` USD), once per user, IP-daily-capped, Turnstile-gated, disable-able. Do not budget on it. |
| Whether the testnet router grants any credit at signup | **UNVERIFIED** — would need a wallet + signup. Testable in ~2 minutes at `pc.testnet.0g.ai`. |
| Whether `zai-org/GLM-5-FP8` still resolves as a legacy alias on `/v1/chat/completions` | **UNVERIFIED** (needs a valid `sk-`). It is absent from `/v1/models` and `/v1/models/{id}` 404s. Treat as gone; 0G's own quickstart is stale. |
| Live `x_0g_trace` field-by-field | Doc-verified, not probe-verified (needs a funded `sk-`). Everything else in §1 was probed. |
| Whether `qwen2.5-omni` actually honours `seed` end-to-end | Advertised in `supported_parameters` (probe-verified) and TeeTLS-relayed to DashScope. **Empirical determinism untested** — run 5 identical calls and diff before relying on it. |
| Does `pricing` from `/v1/models` include the router's own margin? | Docs say no markup; but on-chain `qwen2.5-omni` prompt price is `8.9e11` vs the router's `1.19e12`. **Do not hardcode either.** Read `x_0g_trace.billing` for the truth. |
| Whether 0G will grant a **Project Credit Grant** for a hackathon | **UNVERIFIED.** The API exists (`POST /v1/admin/project-credit-grants`, partner scopes `grants:distribute` / `grants:read`). Worth asking in Discord `#compute` — it would remove the funding constraint entirely. |

**Scratchpad artifacts** (raw evidence, all absolute paths):
`/tmp/claude-1000/-home-mdlog-Project-MDlabs-Akindo-ProofRelay/1dd3ffa9-2368-4d12-8bf9-2db55485205f/scratchpad/` — `models_mainnet.json`, `models_testnet.json`, `providers.json`, `router_ref.txt` (264 KB extracted API reference), `router_*.md` (14 raw doc pages), `inference.md`, `account-management.md`, `testnet.md`, `sdk/package/` (unpacked `@0gfoundation/0g-compute-ts-sdk@0.9.0`).

**Sources:**
- [0G Compute Router — Overview](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview)
- [Router — Quickstart](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/quickstart)
- [Router — Authentication](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/authentication)
- [Router — Models](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/models)
- [Router — Provider Routing](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/routing)
- [Router — Chat Completions](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions)
- [Router — Verifiable Execution](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution)
- [Router — Deposits & Billing](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/account/deposits)
- [Router — Rate Limits](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/rate-limits)
- [Router — Errors](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/errors)
- [Router — Privacy & ZDR](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy)
- [Router — Principles](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/principles)
- [Router — Router vs Direct](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/comparison)
- [Router — FAQ](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/faq)
- [Compute Network — Inference (Direct/SDK)](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference)
- [Compute Network — Account](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/account-management)
- [0G Testnet (Galileo) Overview](https://docs.0g.ai/developer-hub/testnet/testnet-overview)
- [0G Router API reference (changelog)](https://0gfoundation.github.io/0g-router/)
- [npm — @0gfoundation/0g-compute-ts-sdk](https://www.npmjs.com/package/@0gfoundation/0g-compute-ts-sdk)
- [npm — @0glabs/0g-serving-broker (deprecated)](https://www.npmjs.com/package/@0glabs/0g-serving-broker)
- [0G Compute TS starter kit](https://github.com/0gfoundation/0g-compute-ts-starter-kit)
- [dstack (TEE verifier)](https://github.com/Dstack-TEE/dstack)
- [0G Faucet](https://faucet.0g.ai) · [Google Cloud 0G Galileo faucet](https://cloud.google.com/application/web3/faucet/0g/galileo)