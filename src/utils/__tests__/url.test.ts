import { describe, it, expect } from 'vitest';
import { normalizeUrl, getCareerPageCandidates, extractDomain, createVacancyId, hostRole } from '../url';

describe('URL utilities', () => {
  describe('normalizeUrl', () => {
    it('should add https if missing', () => {
      expect(normalizeUrl('example.nl')).toBe('https://example.nl');
    });

    it('should keep https if present', () => {
      expect(normalizeUrl('https://example.nl')).toBe('https://example.nl');
    });

    it('should upgrade http to https', () => {
      expect(normalizeUrl('http://example.nl')).toBe('https://example.nl');
    });
  });

  describe('getCareerPageCandidates', () => {
    it('should return common career page paths', () => {
      const candidates = getCareerPageCandidates('example.nl');
      expect(candidates).toContain('https://example.nl/careers');
      expect(candidates).toContain('https://example.nl/jobs');
      expect(candidates).toContain('https://example.nl/vacatures');
      expect(candidates).toContain('https://example.nl/werken-bij');
    });
  });

  describe('extractDomain', () => {
    it('should extract domain from URL', () => {
      expect(extractDomain('https://www.example.nl/page')).toBe('example.nl');
    });

    it('should handle subdomains', () => {
      expect(extractDomain('https://careers.example.nl')).toBe('example.nl');
    });
  });

  describe('hostRole', () => {
    it('treats apex and www as the site and guessed hosts as other', () => {
      expect(hostRole('https://example.nl/vacatures', 'example.nl')).toBe('apex');
      expect(hostRole('https://www.example.nl/', 'example.nl')).toBe('www');
      expect(hostRole('https://jobs.example.nl/', 'example.nl')).toBe('other');
      expect(hostRole('https://werkenbijexample.nl/', 'example.nl')).toBe('other');
    });
  });

  describe('createVacancyId', () => {
    it('should create consistent hash from URL', () => {
      const id1 = createVacancyId('https://example.nl/job1');
      const id2 = createVacancyId('https://example.nl/job1');
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(12);
    });
  });
});
