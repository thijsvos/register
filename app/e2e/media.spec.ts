import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { note, type Server, serve, vaultWith } from './harness'

/**
 * §04 Rev O and §02b Screen 8: the images and PDFs a note references.
 *
 * A real PNG and a real PDF, because the thing under test is whether a browser
 * will decode and frame them — which hand-rolled magic bytes cannot answer. The
 * first attempt at this used a synthetic PNG no decoder accepts, and every embed
 * reported "not in the vault" while the server correctly answered 200.
 */

/** The repository's own screenshot: a PNG that is definitely a PNG. */
const PNG = readFileSync(join(process.cwd(), '..', 'docs', 'screenshot.png'))

/** A minimal but real PDF — a catalog, one page, and an xref table. */
function pdf(): Buffer {
  const content = Buffer.from('BT /F1 24 Tf 72 700 Td (REGISTER) Tj ET')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R' +
      ' /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const start = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(out, 'binary')
}

let server: Server
test.beforeAll(async () => {
  server = await serve(
    vaultWith({
      'notes/001-note.md': note({
        ref: '001',
        title: 'Note',
        body:
          'A diagram:\n\n![The frame](diagram.png)\n\n' +
          'And a document: [the spec](spec.pdf)\n\n' +
          'A note: [another](002-other.md) and the web: [out](https://example.com)\n\n' +
          'And one that is not there:\n\n![A plan](nowhere.png)\n\n' +
          'Linked as well: [the plan](nowhere.png)\n',
      }),
      // Two references on one line, for the click-target test.
      'notes/002-pair.md': note({
        ref: '002',
        title: 'Pair',
        body: 'Both on one line: ![d](diagram.png) and [s](spec.pdf)\n',
      }),
      'notes/diagram.png': PNG,
      'notes/spec.pdf': pdf(),
    }),
  )
})
test.afterAll(async () => await server.stop())

/** Anything the browser refused, so a silent CSP block cannot pass as success. */
function watchCsp(page: import('@playwright/test').Page): string[] {
  const refused: string[] = []
  page.on('console', (message) => {
    if (/Refused|violates|Content Security/i.test(message.text())) {
      refused.push(message.text())
    }
  })
  return refused
}

async function openTheNote(page: import('@playwright/test').Page) {
  await page.goto(server.url)
  await page.getByRole('button', { name: /Note/ }).first().click()
  await expect(page.locator('.cm-content')).toBeVisible()
}

test('an image renders under its reference, and the reference stays', async ({
  page,
}) => {
  const refused = watchCsp(page)
  await openTheNote(page)

  const image = page.locator('.cm-embed-image')
  await expect(image).toHaveCount(1)
  // Decoded, not merely present: `naturalWidth` is zero for an <img> whose
  // bytes never arrived or could not be read.
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0)

  // §12's rule for this feature: markdown stays the literal source.
  await expect(page.locator('.cm-content')).toContainText('![The frame](diagram.png)')
  expect(refused, 'the CSP refused something').toEqual([])
})

test('a reference with nothing behind it says so', async ({ page }) => {
  await openTheNote(page)
  const missing = page.locator('.cm-embed-missing')
  await expect(missing).toHaveCount(1)
  await expect(missing).toContainText(/not in the vault/i)
})

test('a reference whose target is absent goes inert', async ({ page }) => {
  // The client cannot know a file is missing until a browser has tried, so the
  // reference starts dressed as a link and demotes itself once its image 404s.
  // Asserted after that has happened, which is why it waits for the box first.
  await openTheNote(page)
  await expect(page.locator('.cm-embed-missing')).toHaveCount(1)

  // Both references to it: the image and the plain link. Which syntax wrote it
  // does not change that the file is not there — and only the image can ever
  // find that out, so the link's inertness is the image's discovery reaching it.
  const gone = page.locator('.cm-fileref-missing')
  await expect(gone).toHaveCount(2)
  await expect(gone.first()).toContainText('![A plan](nowhere.png)')
  await expect(gone.last()).toContainText('[the plan](nowhere.png)')
  // Dotted and dim, and carrying no `role="link"` — nothing to open.
  await expect(gone.first()).not.toHaveAttribute('role', 'link')
  await expect(gone.last()).not.toHaveAttribute('role', 'link')

  const dressed = await page
    .locator('.cm-filelink')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-src')))
  expect(dressed).not.toContain('nowhere.png')

  // And clicking either does nothing: no surface, the note stays open.
  await gone.first().click()
  await gone.last().click()
  await expect(page.locator('.media')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('the box for a missing file is inert too', async ({ page }) => {
  await openTheNote(page)
  const box = page.locator('.cm-embed-missing')
  await expect(box).toBeVisible()
  await box.click()
  // It already says "not in the vault"; opening a surface to repeat that is
  // motion for nothing.
  await expect(page.locator('.media')).toHaveCount(0)
})

test('clicking an image opens it on its own surface', async ({ page }) => {
  await openTheNote(page)
  await page.locator('.cm-embed').first().click()

  await expect(page.locator('.media img')).toBeVisible()
  await expect(page.locator('header .crumb')).toContainText('diagram.png')
  // An image is shown, not framed — the frame is for documents.
  await expect(page.locator('.media iframe')).toHaveCount(0)
})

test('a link to a PDF opens it in a frame the CSP permits', async ({ page }) => {
  // The assertion this test exists for. `hardening_headers` puts
  // `frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response, so
  // the app was refused by its own headers — measured in a browser before the
  // carve-out as "Framing … violates … frame-ancestors 'none'". Only the
  // `/api/file` route relaxes to `'self'`.
  const refused = watchCsp(page)
  await openTheNote(page)

  await page.locator('.cm-filelink', { hasText: 'spec.pdf' }).click()

  const frame = page.locator('.media iframe')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('src', /\/api\/file\/notes\/spec\.pdf$/)
  await expect(page.locator('header .crumb')).toContainText('spec.pdf')
  expect(refused, 'the browser refused to frame the document').toEqual([])
})

test('the reference text opens the file, not only the image below it', async ({
  page,
}) => {
  // What a reader actually clicks. The image is drawn *under* its reference, so
  // for the first moment — and forever, if the file is missing — the text is the
  // only thing on screen. Clicking it did nothing at all.
  await openTheNote(page)
  const reference = page.locator('.cm-filelink', { hasText: 'diagram.png' })
  await expect(reference).toHaveCount(1)
  await reference.click()

  await expect(page.locator('.media img')).toBeVisible()
  await expect(page.locator('header .crumb')).toContainText('diagram.png')
})

test('two references on one line open their own targets', async ({ page }) => {
  // The click handler used to recover the target by re-running a regex over the
  // clicked line, which takes the first match — so the second reference on a
  // line opened the first. Each mark carries its own target now.
  await page.goto(server.url)
  await page.getByRole('button', { name: /Pair/ }).first().click()
  await expect(page.locator('.cm-content')).toBeVisible()

  const links = page.locator('.cm-filelink')
  await expect(links).toHaveCount(2)
  await links.nth(1).click()
  await expect(page.locator('header .crumb')).toContainText('spec.pdf')
})

test('only references to servable files are dressed as links', async ({ page }) => {
  // That note holds six references and exactly two are dressed once the page
  // has settled. Two never are: a link to another note, which Screen 8 answers
  // 415 for, and a link to the web, which is not the vault's to show — marking
  // every link would promise a viewer for targets there is none for. The other
  // two are `nowhere.png`, written both ways: both start dressed and demote
  // themselves when the image 404s, which is what the box below is waited on.
  await openTheNote(page)
  await expect(page.locator('.cm-embed-missing')).toHaveCount(1)

  const dressed = page.locator('.cm-filelink')
  await expect(dressed).toHaveCount(2)

  const targets = await dressed.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-src')),
  )
  expect(targets.sort()).toEqual(['diagram.png', 'spec.pdf'])
  expect(targets).not.toContain('002-other.md')
  expect(targets).not.toContain('https://example.com')
})

test('leaving the viewer puts the note back, not the file', async ({ page }) => {
  // The media path has to be cleared when another main view is raised, or
  // dropping out of TODAY shows the file again instead of the note underneath.
  await openTheNote(page)
  await page.locator('.cm-embed').first().click()
  await expect(page.locator('.media img')).toBeVisible()

  // ⌘D raises TODAY; it does not toggle back, so the note is reopened the way a
  // reader would — from the index.
  await page.keyboard.press('ControlOrMeta+d')
  await expect(page.locator('.media')).toHaveCount(0)

  await page.getByRole('button', { name: /Note/ }).first().click()
  await expect(page.locator('.cm-content')).toBeVisible()
  await expect(page.locator('.media')).toHaveCount(0)
})

test('Escape comes back from the viewer', async ({ page }) => {
  await openTheNote(page)
  await page.locator('.cm-embed').first().click()
  await expect(page.locator('.media img')).toBeVisible()

  // §02b Screen 8 says leaving puts you back and drew no way to leave, so this
  // was a one-way trip: the only routes out were raising a *different* view or
  // opening the note again from the index. The key is named on the surface.
  await expect(page.locator('.media .back')).toContainText('Esc')
  await page.keyboard.press('Escape')

  await expect(page.locator('.media')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('and the label that names the key is the control too', async ({ page }) => {
  await openTheNote(page)
  await page.locator('.cm-embed').first().click()
  await expect(page.locator('.media img')).toBeVisible()

  // It read as a control and was not one — micro type on a stamp line, saying
  // the key and answering nothing. A reader who reached for it with the mouse
  // found the only thing on the surface that did not respond.
  const back = page.getByRole('button', { name: /back to the note/i })
  await expect(back).toBeVisible()

  // And it still reads as part of the stamp it sits in. A <button> does not
  // inherit `text-transform` or `letter-spacing` — browsers reset both on form
  // controls — so making the label a control silently turned it sentence-case
  // and untracked, next to a sibling that was neither.
  const micro = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el)
        return `${style.textTransform} ${style.letterSpacing} ${style.fontSize}`
      })
  expect(await micro('.media .back')).toBe(await micro('.media .stamp > span'))

  await back.click()

  await expect(page.locator('.media')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toBeVisible()
})

test('and back to where the note was being read, not the top of it', async ({ page }) => {
  // Short enough that the note has somewhere to scroll to. Asserted below
  // rather than assumed: a viewport that fits the whole note would make the
  // rest of this test pass without proving anything.
  await page.setViewportSize({ width: 1400, height: 420 })
  await openTheNote(page)

  const scroller = page.locator('.cm-scroller')
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const left = await scroller.evaluate((el) => el.scrollTop)
  expect(left, 'the note has to be scrollable for this to mean anything').toBeGreaterThan(
    0,
  )

  await page.locator('.cm-embed').first().click()
  await expect(page.locator('.media')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.cm-content')).toBeVisible()

  // The editor is destroyed and rebuilt by that round trip — the views are
  // alternatives in one `{#if}`, not layers — so coming back used to mean the
  // caret past the frontmatter and the scroll at zero.
  //
  // Asserted against what the note can actually offer rather than a tolerance:
  // an image lays out at a slightly different height on a warm load, so a
  // rebuilt note can be a little shorter than the one that was left. Landing at
  // the furthest it now goes IS where the reader was.
  // Read in one evaluate rather than comparing against a maximum measured
  // beforehand: the note is still growing while this polls, so a max captured
  // early is a max that no longer applies.
  await expect
    .poll(
      () =>
        scroller.evaluate((el, wanted) => {
          const max = el.scrollHeight - el.clientHeight
          return Math.abs(el.scrollTop - Math.min(wanted, max)) <= 1
        }, left),
      { timeout: 3000 },
    )
    .toBe(true)
})

test('a note keeps its place when another one is read in between', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 420 })
  await openTheNote(page)

  const scroller = page.locator('.cm-scroller')
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const left = await scroller.evaluate((el) => el.scrollTop)
  expect(left).toBeGreaterThan(0)

  await page.getByRole('button', { name: /Pair/ }).first().click()
  await expect(page.locator('.cm-content')).toContainText('Both on one line')
  await page.getByRole('button', { name: /Note/ }).first().click()
  await expect(page.locator('.cm-content')).toContainText('A diagram')

  // Read in one evaluate rather than comparing against a maximum measured
  // beforehand: the note is still growing while this polls, so a max captured
  // early is a max that no longer applies.
  await expect
    .poll(
      () =>
        scroller.evaluate((el, wanted) => {
          const max = el.scrollHeight - el.clientHeight
          return Math.abs(el.scrollTop - Math.min(wanted, max)) <= 1
        }, left),
      { timeout: 3000 },
    )
    .toBe(true)
})

test('the app itself still refuses to be framed', async ({ page }) => {
  // The carve-out must be one route wide. If it leaked to the shell, the
  // clickjacking protection the whole app relies on would be gone.
  await page.goto(server.url)
  const headers = await page.evaluate(async () => {
    const shell = await fetch('/')
    const media = await fetch('/api/file/notes/diagram.png')
    return {
      shell: shell.headers.get('content-security-policy') ?? '',
      shellFrame: shell.headers.get('x-frame-options') ?? '',
      media: media.headers.get('content-security-policy') ?? '',
      mediaFrame: media.headers.get('x-frame-options') ?? '',
    }
  })
  expect(headers.shell).toContain("frame-ancestors 'none'")
  expect(headers.shellFrame).toBe('DENY')
  expect(headers.media).toContain("frame-ancestors 'self'")
  expect(headers.mediaFrame).toBe('SAMEORIGIN')
})

test('a note is not served as a file, and a traversal is refused', async ({ page }) => {
  await page.goto(server.url)
  const answers = await page.evaluate(async () => {
    const at = async (path: string) => (await fetch(path)).status
    return {
      note: await at('/api/file/notes/001-note.md'),
      app: await at('/api/file/.register/config.json'),
      missing: await at('/api/file/notes/absent.png'),
      image: await at('/api/file/notes/diagram.png'),
    }
  })
  expect(answers.image).toBe(200)
  expect(answers.note).toBe(415)
  expect(answers.app).toBe(400)
  expect(answers.missing).toBe(404)
})
