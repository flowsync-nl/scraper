import { describe, it, expect } from 'vitest';
import { RecruiteeParser } from '../recruitee';
import { parseWithPlatform } from '../index';

describe('RecruiteeParser', () => {
  const parser = new RecruiteeParser();

  it('should extract company ID from URL', () => {
    expect(parser.extractCompanyId('https://acme.recruitee.com')).toBe('acme');
    expect(parser.extractCompanyId('https://acme.recruitee.com/o/developer')).toBe('acme');
  });

  it('should parse vacancy from API response', () => {
    const apiOffer = {
      id: 123,
      title: 'Senior Developer',
      city: 'Amsterdam',
      careers_url: 'https://acme.recruitee.com/o/senior-developer',
      description: 'We are looking for...',
      created_at: '2026-01-01T10:00:00Z',
      department: { name: 'Engineering' },
      employment_type_code: 'full_time',
    };

    const vacancy = parser.parseVacancy(apiOffer, 'https://acme.recruitee.com');

    expect(vacancy.title).toBe('Senior Developer');
    expect(vacancy.location).toBe('Amsterdam');
    expect(vacancy.department).toBe('Engineering');
    expect(vacancy.type).toBe('fulltime');
  });

  it('does not throw when the host is not recruitee.com', async () => {
    await expect(parseWithPlatform('recruitee', 'https://bas-hr.nl/vacatures')).resolves.toBeNull();
  });
});
