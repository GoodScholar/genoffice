---
title: Lossless GFM
tags: [markdown, fixture]
---

# Core GFM

Task list:

- [x] preserve **strong** and _emphasis_
- [ ] preserve ~~strikethrough~~ and [a link](https://example.com)

| Name  | Value |
| ----- | ----: |
| alpha |     1 |
| beta  |     2 |

Inline math is $E = mc^2$.

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

```mermaid
flowchart LR
  A[Source] --> B[Projection]
  B --> C[Editor]
```

> A block quote with a line break.
> It remains GFM.
