---
name: lyrenth-web-reading
description: Read the content of one or many public web pages through Lyrenth, as clean Markdown instead of raw HTML. Use when the user gives a URL to read, summarize, quote, compare or extract from, or when a link needs to be opened to answer a question.
---

# Reading the web with Lyrenth

Lyrenth turns a public URL into an AIDocument: clean Markdown plus the
page title, description and structure, with navigation, menus, cookie
banners and other boilerplate removed. Reads come from Lyrenth's own
index of over 2 billion pages, which grows by over 50 million pages a
day. A page nobody has read yet is fetched once, then everyone gets the
fast copy.

Use it whenever you need what a page actually says.

## When to use this skill

Use it when the user:

- gives you one or more URLs and asks you to read, summarize, quote,
  compare, translate or extract from them
- asks a question whose answer is on a page you already have the link to
- asks you to check what a specific page says right now
- pastes a link and asks anything about it

Do not use it when:

- the user is asking about something that needs no page at all
- the URL is behind a login, a paywall or on a private network. Lyrenth
  reads public pages only, so say that rather than trying
- the user asked you to change something on a page. These tools only
  read; none of them can post, edit or delete anything

## The tools

`read_url` reads one page.

- `url`: the absolute http or https address. Required.
- `fresh`: set true only when the user needs the very latest version of a
  page that changes often, such as a live status page. It is slower.
  Leave it off otherwise.
- `max_tokens`: cap the returned text when your context is tight. The
  text is trimmed at a clean paragraph or sentence boundary, so a capped
  read stays readable.

`read_urls` reads up to 20 pages in one call.

- Prefer it over calling `read_url` in a loop. It is faster, and one bad
  URL is reported on its own line instead of stopping the rest.
- Same `fresh` and `max_tokens` arguments, applied to every URL.

`check_usage` reports the plan and how many reads are left this month.

- Call it when a read fails with a limit message, or when the user asks
  how much they have used. It takes no arguments.

## How to work

1. Collect every URL the user gave you before calling anything.
2. One URL, call `read_url`. Two or more, call `read_urls` once with all
   of them. Split into batches of 20 if there are more than 20.
3. Read the header that comes back before the body. It carries the page
   title, the final address after any redirect, and how many words and
   tokens the page came to. If the final address is a different page than
   the one asked for, say so.
4. Answer from the returned text. Quote it when the user asked for a
   quote, and keep the quote short.
5. Give the user the source link for anything you took from a page, so
   they can check it.

## What not to do

- Do not answer from memory when the user gave you a link. Read it.
- Do not fill in a section that the returned text does not contain. If
  the page did not say it, say that the page did not say it.
- Do not guess a URL. If the user names a site without a link, ask for
  the link or ask which page they mean.
- Do not retry a failed read more than once. Report what came back.
- Do not set `fresh` on every call. Most pages do not change between one
  minute and the next, and a forced fetch is slower for no gain.

## When a read fails

The tools return the reason in plain words. Pass it on rather than
guessing at it.

- No key, or an invalid key: the user needs to connect their Lyrenth
  account, or get a free key at https://lyrenth.com/signup. Tell them
  that and stop.
- Disallowed by the site's robots.txt: Lyrenth respects robots.txt on
  every fetch, so that page will not be read, now or later. Say so and
  offer to look for the same information elsewhere. Do not try to reach
  it another way.
- Monthly limit reached: say the limit is reached and when it resets.
  Call `check_usage` if the user wants the numbers.
- The page itself failed, timed out or returned nothing readable: say
  which URL failed and what came back. In a batch, the other pages still
  worked, so use them.
