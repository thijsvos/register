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
          'And one that is not there:\n\n![A plan](nowhere.png)\n',
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

  await expect(page.locator('.cm-filelink')).toHaveCount(1)
  await page.locator('.cm-filelink').first().click()

  const frame = page.locator('.media iframe')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('src', /\/api\/file\/notes\/spec\.pdf$/)
  await expect(page.locator('header .crumb')).toContainText('spec.pdf')
  expect(refused, 'the browser refused to frame the document').toEqual([])
})

test('only a link to a servable file is dressed as one', async ({ page }) => {
  // Three links in that note and exactly one of them opens a surface. Marking
  // every link would promise a viewer for targets there is none for — and
  // `fileUrl` resolves any vault-relative path, `.md` included, so a link to
  // another note would have opened Screen 8 onto its own 415.
  await openTheNote(page)
  await expect(page.locator('.cm-filelink')).toHaveCount(1)
  await expect(page.locator('.cm-filelink')).toContainText('the spec')
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
