# GenClass Runtime: privacy policy

_Last updated: 2026-10-09._

This policy covers the diagnostics that `@genclass/runtime` (from `0.1.0-beta.3`) sends to its maintainers. It does not
cover the website or app that uses GenClass; that site has its own privacy policy.

## Who we are

GenClass is maintained by Daybot Solutions Inc. ("we"). Contact: karan@daybot.ca.

## What we collect

When a website runs GenClass with telemetry on (the default), the browser sends us:

- **Decisions the runtime made:** what kind of event it looked at (for example a network response or a store
  write), the model's diagnosis and suggested action, its confidence, and whether anything was changed or undone.
- **The situation text the model read.** This describes recent app activity: request paths, store field names and
  short summaries of their values, and timing. GenClass removes passwords, payment details and fields whose names
  look like secrets before this text is created. Other values, such as names or search terms typed into the app,
  can appear in shortened form.
- **Technical details:** GenClass and model versions, settings, device type (WebGPU or WASM), load times and error
  counts, and the website's hostname.
- **Your approximate country**, from our server provider.

We do **not** store IP addresses, browser user-agent strings or cookies, and we do not set cookies. Each page
load gets a random session ID that is not saved anywhere.

## Why we collect it

To measure how well the model works and to train better versions of it. We do not sell the data, use it for
advertising, or try to identify individual people.

## Where it goes and how long we keep it

Data is sent to our collector on Cloudflare and stored in Cloudflare R2. It is deleted automatically after
**90 days**. Only GenClass maintainers can access it. Cloudflare processes it on our behalf.

## How to turn it off

- Developers: `GenClass.init({ telemetry: false })`.
- Anyone: add `?genclass=no-telemetry` to the page URL, or run
  `localStorage.setItem("genclass.telemetry", "off")` in the browser console.
- Browsers that send the **Global Privacy Control** signal are never collected.

## Your rights

Because we do not keep IP addresses or user accounts, we usually cannot tell which data came from you. If you have a
question or request (access, deletion or objection), contact karan@daybot.ca and we will do what we can. You
can also contact your local data protection authority.

## For developers using GenClass

The data comes from your users' browsers. Depending on where you operate, you may need to mention GenClass in your
own privacy policy, or keep `telemetry: false` until your users consent to analytics. Full technical details are in
[TELEMETRY.md](packages/runtime/TELEMETRY.md).

## Changes

We will update this page and the CHANGELOG when we change what we collect or how long we keep it.
