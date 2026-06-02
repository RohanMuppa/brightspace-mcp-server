# Disclaimer and Intended Use

## AI-Initiated Actions and Writes

This Model Context Protocol (MCP) server allows AI assistants (such as Claude, ChatGPT, or Cursor) to interact directly with your Brightspace (D2L) environment. 

Because the AI can perform actions on your behalf (e.g., posting announcements or querying course details):
* **AI outputs and actions are non-deterministic.** An LLM may misinterpret a prompt or execute tools in an unintended order.
* **Review all draft actions before execution.** If your AI client supports a confirmation step before executing tools (especially write operations like announcement creation), ensure it is enabled.
* **No validation safety net.** The server executes commands using your session authority. It does not validate the academic appropriateness, correctness, or formatting of the content you or the AI post.

---

## Client-Side Session Emulation & Authentication

Unlike standard integrations that use restricted OAuth scopes or API keys, this server uses **Client-Side Session Emulation** via Playwright to mimic a browser session:
* This grants the AI client **the exact same permissions and authority as your user account** (including high-permission faculty write operations).
* Session cookies and CSRF tokens are captured locally and stored using local AES-256-GCM encryption.
* **Local Security Responsibility:** You are solely responsible for securing the local machine where this server is installed. If your machine is compromised, the encrypted session storage could potentially be accessed.

---

## Institutional IP and Student Privacy (FERPA / Freedom of Information)

Brightspace environments contain highly sensitive institutional intellectual property and student records (such as grades, assignments, and class rosters):
* **Do not expose sensitive data to unauthorized LLM providers.** Depending on which AI client and model you use, data sent in prompts (e.g., class lists, grade files, student submissions) may be processed by third-party cloud providers. Use caution and consult your institution's data privacy policies.
* **Repository hygiene:** Never commit your `.env` file, local databases, or session cookie cache to public repositories. Ensure the `.gitignore` file remains active and correctly configured.

---

## Unsupported Toolchain

This project is an **experimental, personally-developed tool**. It is not an official D2L/Brightspace product and is not endorsed or supported by D2L, NSCC, or any academic institution's IT department. 
* There is no official helpdesk, SLA, or guarantee of continued maintenance.
* Brightspace updates or security changes may break the session emulation scraping mechanisms at any time.
* Use at your own risk. The developer assumes no liability for accidental data loss, incorrect grading, unauthorized disclosures, or policy violations.

---

## Summary of Key Limitations & Risks

| Area | Implication / Risk | Mitigation |
|---|---|---|
| **AI Write Operations** | AI might post incorrect/incomplete announcements or content. | Always review and verify AI-generated content before allowing write operations. |
| **Session Authority** | The AI has full access to anything your account can do on Brightspace. | Do not use the server in high-privilege environments without close supervision. |
| **Third-Party Data Processing** | Prompts containing student records may be sent to external AI servers. | Ensure your AI client conforms to your institution's privacy and data agreements. |
| **No Institutional Support** | Academic IT departments cannot assist with debugging, configuration, or troubleshooting. | Self-support only; check log outputs and issues on GitHub. |
| **Fragility of Emulation** | Brightspace UI changes can break page parsing. | Keep the repository up-to-date and be prepared for potential connection failures. |
