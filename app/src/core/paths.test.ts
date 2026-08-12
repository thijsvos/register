import { describe, expect, it } from 'vitest'
import {
  cleanFolder,
  dailyDate,
  folders,
  inside,
  isConflictCopy,
  isContract,
  isDaily,
  isDerived,
  isIndexed,
  isListed,
  isTemplate,
  resolveSrc,
  splitFolder,
} from './paths'

const CONFLICT = 'notes/003-a.conflict-20260805T101500000Z.md'

describe('the four kinds of file a vault holds', () => {
  it.each([
    ['notes/003-terminal.md', true, true],
    ['000-inbox.md', true, true],
    // The journal: hidden from the INDEX because there is one per day forever
    // and `daily/` sorts above `notes/`, but counted, because its tasks are the
    // ones people actually write. This pair is why listed and derived stopped
    // being nested — no other kind of file wants hidden-and-counted.
    ['daily/2026-08-05.md', false, true],
    // Furniture: real files, edited deliberately, but not notes.
    ['CLAUDE.md', false, false],
    ['templates/daily.md', false, false],
    ['templates/nested/weekly.md', false, false],
    // An artefact is listed — the index is the only place you would find one —
    // and derived from by nothing, because its lines belong to the original.
    [CONFLICT, true, false],
  ])('%s → listed %s, derived %s', (path, listed, derivedFrom) => {
    expect(isListed(path)).toBe(listed)
    expect(isDerived(path)).toBe(derivedFrom)
  })

  it('only matches the contract at the vault root', () => {
    expect(isContract('CLAUDE.md')).toBe(true)
    // A note that happens to be about the contract is still a note.
    expect(isContract('notes/007-claude-md.md')).toBe(false)
    expect(isListed('notes/007-claude-md.md')).toBe(true)
  })

  it('does not mistake a folder that merely ends in templates', () => {
    expect(isTemplate('my-templates/daily.md')).toBe(false)
    expect(isTemplate('notes/003-templates.md')).toBe(false)
  })

  it('spots a conflict copy wherever it sits', () => {
    expect(isConflictCopy(CONFLICT)).toBe(true)
    expect(isConflictCopy('notes/003-a.md')).toBe(false)
  })

  it('does not mistake a folder that merely ends in daily', () => {
    expect(isDaily('my-daily/2026-08-05.md')).toBe(false)
    expect(isDaily('notes/003-daily-habits.md')).toBe(false)
    expect(isListed('notes/003-daily-habits.md')).toBe(true)
  })

  it('keeps listed and derived independent, which is the point', () => {
    // Every combination is reachable, and each has an owner. Written as
    // `isListed && !isConflictCopy` the third row is unexpressible, and a daily
    // log would have to be either visible in the index or absent from TODAY.
    const kinds: [string, boolean, boolean][] = [
      ['notes/003-a.md', true, true], // shown and counted
      ['CLAUDE.md', false, false], // hidden and uncounted
      ['daily/2026-08-05.md', false, true], // hidden and counted
      [CONFLICT, true, false], // shown and uncounted
    ]
    for (const [path, listed, derivedFrom] of kinds) {
      expect([isListed(path), isDerived(path)], path).toEqual([listed, derivedFrom])
    }
  })
})

describe('folders', () => {
  it('names the directories a note sits in, outermost first', () => {
    expect(folders('notes/archive/018-old.md')).toEqual(['notes', 'archive'])
  })

  it('names nothing for a note at the vault root', () => {
    expect(folders('000-inbox.md')).toEqual([])
  })

  it('does not compact the way the tree does', () => {
    // The INDEX draws `projects/apollo` as one row because a level offering no
    // choice does not earn indentation. A crumb answers "where is this file",
    // and eliding a real folder would make that answer wrong to save characters.
    expect(folders('notes/projects/apollo/010-launch.md')).toEqual([
      'notes',
      'projects',
      'apollo',
    ])
  })

  it('survives a path someone else wrote', () => {
    expect(folders('a//b.md')).toEqual(['a'])
    expect(folders('')).toEqual([])
  })
})

describe('resolveSrc', () => {
  it('resolves a bare name against the note’s own folder', () => {
    expect(resolveSrc('notes/001-a.md', 'diagram.png')).toBe('notes/diagram.png')
    expect(resolveSrc('notes/archive/018-old.md', 'diagram.png')).toBe(
      'notes/archive/diagram.png',
    )
  })

  it('treats a leading slash as the vault root', () => {
    expect(resolveSrc('notes/archive/018-old.md', '/assets/logo.png')).toBe(
      'assets/logo.png',
    )
  })

  it('resolves .. rather than sending it to a server that refuses it', () => {
    expect(resolveSrc('notes/projects/010-launch.md', '../shared/plan.png')).toBe(
      'notes/shared/plan.png',
    )
    expect(resolveSrc('notes/001-a.md', './diagram.png')).toBe('notes/diagram.png')
  })

  it('refuses anything that climbs out of the vault', () => {
    // Not clamped to the root: silently resolving an escape would turn a wrong
    // link into a different wrong link, and the server refuses it anyway.
    expect(resolveSrc('notes/001-a.md', '../../etc/passwd')).toBeNull()
    expect(resolveSrc('000-inbox.md', '../secrets.png')).toBeNull()
  })

  it('refuses anything with a scheme, which the CSP would refuse too', () => {
    for (const remote of [
      'https://example.com/x.png',
      'http://example.com/x.png',
      'data:image/png;base64,AAAA',
      '//example.com/x.png',
    ]) {
      expect(resolveSrc('notes/001-a.md', remote), remote).toBeNull()
    }
  })

  it('refuses an empty or root-only reference', () => {
    expect(resolveSrc('notes/001-a.md', '')).toBeNull()
    expect(resolveSrc('notes/001-a.md', '   ')).toBeNull()
    expect(resolveSrc('notes/001-a.md', '/')).toBeNull()
  })

  it('resolves against a note at the vault root', () => {
    expect(resolveSrc('000-inbox.md', 'shot.png')).toBe('shot.png')
    expect(resolveSrc('000-inbox.md', 'assets/shot.png')).toBe('assets/shot.png')
  })
})

describe('inside', () => {
  it('holds for a path under the folder, at any depth', () => {
    expect(inside('notes/projects/010-a.md', 'notes/projects')).toBe(true)
    expect(inside('notes/projects/deep/011-b.md', 'notes/projects')).toBe(true)
    expect(inside('notes/projects/010-a.md', 'notes')).toBe(true)
  })

  it('does not hold for the folder beside it', () => {
    // The trailing separator is the whole function. A bare prefix test puts
    // this note inside `notes/projects`, which is one folder too many to
    // delete.
    expect(inside('notes/projects-old/010-a.md', 'notes/projects')).toBe(false)
    expect(inside('notes/projectsomething.md', 'notes/projects')).toBe(false)
  })

  it('does not hold for the folder itself', () => {
    expect(inside('notes/projects', 'notes/projects')).toBe(false)
  })
})

describe('splitFolder', () => {
  it('reads the folder off the last separator', () => {
    expect(splitFolder('notes/projects/Launch plan')).toEqual({
      folder: 'notes/projects',
      title: 'Launch plan',
    })
  })

  it('leaves a plain title alone', () => {
    // What every existing route into creation passes, including a wikilink
    // followed to a note that does not exist yet.
    expect(splitFolder('Terminal aesthetics')).toEqual({
      folder: null,
      title: 'Terminal aesthetics',
    })
  })

  it('reads a completed folder with no title yet', () => {
    // Exactly what choosing a suggestion types for you.
    expect(splitFolder('notes/projects/')).toEqual({
      folder: 'notes/projects',
      title: '',
    })
  })

  it('trims either side, since the separator is typed by hand', () => {
    expect(splitFolder(' notes/projects / Launch ')).toEqual({
      folder: 'notes/projects',
      title: 'Launch',
    })
  })
})

describe('cleanFolder', () => {
  it('keeps a plain nested path as it is', () => {
    expect(cleanFolder('notes/projects')).toBe('notes/projects')
    expect(cleanFolder('archive')).toBe('archive')
  })

  it('refuses a separator with nothing either side of it', () => {
    // `/Foo` used to yield an empty folder, an absolute path on the wire, and a
    // create that failed with "already exists" about a note that never existed.
    expect(cleanFolder('/notes')).toBeNull()
    expect(cleanFolder('notes/')).toBeNull()
    expect(cleanFolder('notes//projects')).toBeNull()
    expect(cleanFolder('')).toBeNull()
  })

  it('refuses a dot segment, which is three rules in one', () => {
    // `..` never reached the server as `..`: fetch collapses it in the URL, so
    // `notes/../templates` arrived as `templates` and was accepted. The only
    // place that can be caught is before the request is built.
    expect(cleanFolder('notes/../templates')).toBeNull()
    expect(cleanFolder('..')).toBeNull()
    expect(cleanFolder('.')).toBeNull()
    expect(cleanFolder('.register')).toBeNull()
    expect(cleanFolder('notes/.hidden')).toBeNull()
  })

  it('refuses the separators the server refuses', () => {
    expect(cleanFolder('notes\\projects')).toBeNull()
    expect(cleanFolder('notes\u0000')).toBeNull()
  })

  it('refuses the vault furniture whatever case it is typed in', () => {
    // The filesystem folds case and the guard did not, so `Templates/Launch`
    // landed in the real `templates/`: written, hidden from the INDEX, and
    // offered back as a phantom stencil.
    expect(cleanFolder('templates')).toBeNull()
    expect(cleanFolder('Templates')).toBeNull()
    expect(cleanFolder('TEMPLATES/deep')).toBeNull()
    expect(cleanFolder('daily')).toBeNull()
    expect(cleanFolder('Daily/2026')).toBeNull()
  })

  it('allows a nested folder that merely shares the name', () => {
    // `isTemplate` is a top-level rule, so this is a folder like any other.
    expect(cleanFolder('notes/templates')).toBe('notes/templates')
  })
})

describe('dailyDate', () => {
  it('reads the date off the filename', () => {
    expect(dailyDate('daily/2026-08-12.md')).toBe('2026-08-12')
  })

  it('reads it even when the note calls itself something else', () => {
    // The point of using the filename. A log written by an older build can be
    // titled TEMPLATE, and an index repeating that back is unusable exactly
    // where a journal has to be reliable.
    expect(dailyDate('daily/2026-08-11.md')).toBe('2026-08-11')
  })

  it('is null for anything not shaped like a daily log', () => {
    expect(dailyDate('notes/003-a.md')).toBeNull()
    expect(dailyDate('daily/notes.md')).toBeNull()
    expect(dailyDate('daily/2026-08.md')).toBeNull()
    expect(dailyDate('archive/daily/2026-08-12.md')).toBeNull()
  })
})

describe('isIndexed', () => {
  it('draws your notes and your journal', () => {
    expect(isIndexed('notes/003-a.md')).toBe(true)
    expect(isIndexed('daily/2026-08-12.md')).toBe(true)
  })

  it('still leaves the furniture out', () => {
    expect(isIndexed('templates/daily.md')).toBe(false)
    expect(isIndexed('CLAUDE.md')).toBe(false)
  })

  it('is wider than isListed by exactly the journal', () => {
    // The two govern different questions: what is drawn, and what counts as a
    // note you filed. A daily log is drawn and is not one of those.
    expect(isListed('daily/2026-08-12.md')).toBe(false)
  })
})
