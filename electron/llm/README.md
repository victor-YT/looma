# Provider Integration Notes

This folder defines the runtime contract for model providers.

## What a provider owns

- Declaring attachment-related capabilities in the provider adapter when support is uniform across that provider.
- Converting `UIMessage[]` plus hydrated attachment parts into the provider's request payload.
- Returning streamed or non-streamed text output.
- Normalizing provider-specific errors.

## What the host owns

- Reading local files and staging bytes.
- Hydrating asset references into attachment data before provider calls.
- Validating attachment limits and MIME allowlists before send.
- Reusing provider-side file IDs when a transport supports it.

## Attachment transport semantics

- `remote_file_id`: The host uploads files first and rewrites message parts to provider file references.
- `inline_base64`: The provider request embeds base64 file data directly.
- `inline_parts`: The provider request embeds structured binary parts directly.
- `none`: The provider does not support native attachments.

## Capability guidance

- Put capabilities in the provider adapter when they apply to every model from that provider.
- Put capabilities in `electron/config/models.json` when support varies by model.
- Dynamic local models inherit provider attachment capabilities from `modelRegistry.ts`.

## Current patterns

- `openai` uses the OpenAI-compatible factory with `remote_file_id`.
- `lmstudio` uses the OpenAI-compatible factory with image-only `inline_base64`.
- `gemini` implements its own inline-part mapping.
- `anthropic` implements its own content-block mapping for image and PDF inputs.
- `ollama` implements image-only chat payload mapping.
