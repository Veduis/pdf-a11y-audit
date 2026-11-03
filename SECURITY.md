# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Please use the private contact form at <https://remediatepdf.com/contact> and
select the security topic. Do not open a public issue for a vulnerability.

Include the version, the operating system, a minimal PDF or reproduction steps,
and the impact you observed. We will acknowledge the report and coordinate a
fix and disclosure date.

## Scope

`pdf-a11y-audit` reads local PDF files. It does not upload documents, does not
open a network connection and does not call a model. The highest-risk area is a
malicious PDF exploiting the parser; keep Node.js and the dependency tree
current and run the auditor on files you are prepared to parse.
