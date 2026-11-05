import { describe, expect, it } from 'vitest';
import { canPreview, formatSize, isPrivateCopy, localFileName, localFolderName, uploadFileName, uploadProblem } from './attachment-rules';

describe('the name a downloaded file is stored under', () => {
  it.each([
    ['../../../Library/Preferences/x.png', 'x.png'],
    ['..\\..\\evil.png', 'evil.png'],
    ['/etc/passwd', 'passwd'],
    ['..', 'file'],
    ['', 'file'],
    ['.hidden.txt', 'hidden.txt'],
    ['a\u0000b:c.txt', 'abc.txt'],
    ['invoice 2026.pdf', 'invoice 2026.pdf'],
  ])('turns %j into %j', (input, expected) => {
    expect(localFileName(input)).toBe(expected);
  });

  it('keeps the extension when it shortens a long name', () => {
    const name = localFileName(`${'a'.repeat(300)}.pdf`);
    expect(name).toHaveLength(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('never lets an attachment ID choose a folder', () => {
    expect(localFolderName('../../x')).toBe('______x');
    expect(localFolderName('att_01ABC-z')).toBe('att_01ABC-z');
  });
});

describe('the name a picked file is uploaded under', () => {
  it('agrees with the type, as the installation requires', () => {
    expect(uploadFileName('IMG_1.HEIC', 'image/jpeg')).toBe('IMG_1.jpg');
    expect(uploadFileName('photo', 'image/png')).toBe('photo.png');
    expect(uploadFileName(null, 'image/jpeg')).toBe('file.jpg');
  });

  it('leaves a name that already agrees', () => {
    expect(uploadFileName('A.JPEG', 'image/jpeg')).toBe('A.JPEG');
    expect(uploadFileName('notes.log', 'text/plain')).toBe('notes.log');
  });

  it('leaves a type it does not know for the installation to refuse', () => {
    expect(uploadFileName('run.exe', 'application/x-msdownload')).toBe('run.exe');
  });
});

describe('which picked files may be deleted', () => {
  it.each([
    'file:///var/mobile/Containers/Data/Application/A/tmp/com.orangolabs.openchat-Inbox/a.pdf',
    'file:///var/mobile/Containers/Data/Application/A/Library/Caches/ImagePicker/b.jpg',
  ])('allows the app\'s own copy %s', (uri) => {
    expect(isPrivateCopy(uri)).toBe(true);
  });

  it.each([
    'file:///var/mobile/Containers/Shared/AppGroup/B/File%20Provider%20Storage/a.pdf',
    'file:///var/mobile/Containers/Data/Application/A/Documents/a.pdf',
    'file:///var/mobile/Containers/Data/Application/A/tmp/../Documents/a.pdf',
  ])('refuses %s', (uri) => {
    expect(isPrivateCopy(uri)).toBe(false);
  });
});

describe('previews', () => {
  const picture = { contentType: 'image/png', size: 1000, status: 'ready' };

  it('shows small, ready pictures', () => {
    expect(canPreview(picture)).toBe(true);
  });

  it.each([
    ['SVG, which can hold scripts', { ...picture, contentType: 'image/svg+xml' }],
    ['a PDF', { ...picture, contentType: 'application/pdf' }],
    ['a large picture', { ...picture, size: 6 * 1024 * 1024 }],
    ['a file that is not ready', { ...picture, status: 'pending' }],
    ['a refused file', { ...picture, status: 'rejected' }],
  ])('does not show %s', (_, file) => {
    expect(canPreview(file)).toBe(false);
  });
});

describe('sizes and problems', () => {
  it('reads sizes', () => {
    expect(formatSize(10)).toBe('1 KB');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('explains an upload the installation refused', () => {
    expect(uploadProblem(413)).toContain('too large');
    expect(uploadProblem(415)).toContain('not allowed');
    expect(uploadProblem(undefined)).toContain('did not upload');
  });
});
