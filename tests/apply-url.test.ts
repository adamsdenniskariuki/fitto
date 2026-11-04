import { describe, expect, it } from "vitest";
import { finalize, pickApplyUrl } from "../src/normalize.js";
import { parseHnComment } from "../src/sources/boards.js";
import { submitUrl } from "../src/submit.js";

const HN_HTML =
  'eventfirst | Senior Full-Stack Engineer | Berlin, Germany | REMOTE (CET) | Full-time | eventfirst.com<p>We build things.<p>Apply here: <a href="https:&#x2F;&#x2F;eventfirst.jobs.personio.com&#x2F;job&#x2F;2870690?_pc=3355738" rel="nofollow">https:&#x2F;&#x2F;eventfirst.jobs.personio.com&#x2F;job&#x2F;2870690?_pc=3355738</a>';

describe("apply links", () => {
  it("prefers ATS postings, then careers pages, and skips HN and truncated links", () => {
    expect(pickApplyUrl("see https://news.ycombinator.com/item?id=1 and https://acme.com/careers/eng.")).toBe("https://acme.com/careers/eng");
    expect(pickApplyUrl("https://acme.com/careers https://jobs.lever.co/acme/123")).toBe("https://jobs.lever.co/acme/123");
    expect(pickApplyUrl("https://acme.com/about https://boards.greenhouse.io/acme/jobs/1...")).toBeUndefined();
    expect(pickApplyUrl("no links here")).toBeUndefined();
  });

  it("HN comments carry their application link", () => {
    const raw = parseHnComment({ objectID: "50341824", comment_text: HN_HTML })!;
    expect(raw.url).toBe("https://news.ycombinator.com/item?id=50341824");
    expect(raw.applyUrl).toBe("https://eventfirst.jobs.personio.com/job/2870690?_pc=3355738");
    expect(submitUrl(finalize(raw))).toBe(raw.applyUrl);
  });

  it("older HN records fall back to a link in the description; other sources keep their URL", () => {
    const raw = parseHnComment({ objectID: "1", comment_text: HN_HTML })!;
    delete raw.applyUrl;
    expect(submitUrl(finalize(raw))).toBe("https://eventfirst.jobs.personio.com/job/2870690?_pc=3355738");
    const gh = finalize({ ...raw, source: "greenhouse", url: "https://boards.greenhouse.io/x/jobs/1" });
    expect(submitUrl(gh)).toBe("https://boards.greenhouse.io/x/jobs/1");
  });
});
