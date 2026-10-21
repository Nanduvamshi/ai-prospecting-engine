'use client';

/**
 * Prospect Import/Export Utilities
 * Handles CSV, JSON, and LinkedIn URL import/export for prospects
 */

import {
  isValidEmail,
  escapeCSVField,
  parseCSVLine,
  readFileAsText,
  downloadFile,
} from './csv';

// ============================================
// TYPES
// ============================================

export interface ProspectData {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  linkedinUrl?: string;
  website?: string;
  avatar?: string;
  source?: 'linkedin' | 'website' | 'referral' | 'event' | 'manual' | 'import';
  status?: 'new' | 'researching' | 'qualified' | 'contacted' | 'converted' | 'disqualified';
  score?: number;
  tags?: string[];
  notes?: string;
}

interface LinkedInProfile {
  url: string;
  username?: string;
  isValid: boolean;
}

// ============================================
// CSV EXPORT
// ============================================

export function exportProspectsToCSV(prospects: ProspectData[]): string {
  if (prospects.length === 0) {
    return 'name,email,phone,company,title,linkedinUrl,website,source,status,score,tags,notes';
  }

  const headers = ['name', 'email', 'phone', 'company', 'title', 'linkedinUrl', 'website', 'source', 'status', 'score', 'tags', 'notes'];
  const rows = prospects.map(prospect => [
    escapeCSVField(prospect.name),
    escapeCSVField(prospect.email || ''),
    escapeCSVField(prospect.phone || ''),
    escapeCSVField(prospect.company || ''),
    escapeCSVField(prospect.title || ''),
    escapeCSVField(prospect.linkedinUrl || ''),
    escapeCSVField(prospect.website || ''),
    prospect.source || 'manual',
    prospect.status || 'new',
    prospect.score?.toString() || '0',
    escapeCSVField(prospect.tags?.join(';') || ''),
    escapeCSVField(prospect.notes || ''),
  ]);

  return [
    headers.join(','),
    ...rows.map(row => row.join(',')),
  ].join('\n');
}

export function downloadProspectsAsCSV(prospects: ProspectData[]): void {
  const csv = exportProspectsToCSV(prospects);
  const timestamp = new Date().toISOString().split('T')[0];
  downloadFile(csv, `prospects-${timestamp}.csv`, 'text/csv');
}

export function downloadProspectsAsJSON(prospects: ProspectData[]): void {
  const json = JSON.stringify(prospects, null, 2);
  const timestamp = new Date().toISOString().split('T')[0];
  downloadFile(json, `prospects-${timestamp}.json`, 'application/json');
}

export function generateCSVTemplate(): string {
  return `name,email,phone,company,title,linkedinUrl,website,notes
John Doe,john@example.com,+1234567890,Acme Corp,CEO,https://linkedin.com/in/johndoe,https://acme.com,Met at conference
Jane Smith,jane@techco.com,+0987654321,TechCo,CTO,https://linkedin.com/in/janesmith,https://techco.com,Referred by mutual contact`;
}

// ============================================
// CSV IMPORT
// ============================================

export function parseProspectsFromCSV(csvContent: string): ProspectData[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('CSV must contain headers and at least one data row');
  }

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const prospects: ProspectData[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = parseCSVLine(lines[i]);
      if (values.length === 0 || values.every(v => !v.trim())) continue;

      const prospect = mapCSVRowToProspect(headers, values);
      validateProspect(prospect, i + 1);
      prospects.push(prospect);
    } catch (error) {
      errors.push({
        row: i + 1,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  if (errors.length > 0 && prospects.length === 0) {
    throw new Error(
      `All rows failed validation:\n${errors.map(e => `Row ${e.row}: ${e.message}`).join('\n')}`
    );
  }

  return prospects;
}

// ============================================
// JSON IMPORT
// ============================================

export function parseProspectsFromJSON(jsonContent: string): ProspectData[] {
  const data = JSON.parse(jsonContent);
  const prospects = Array.isArray(data) ? data : [data];

  return prospects.map((prospect: any, index: number) => {
    const mapped: ProspectData = {
      name: prospect.name || '',
      email: prospect.email || '',
      phone: prospect.phone || undefined,
      company: prospect.company || prospect.companyName || undefined,
      title: prospect.title || prospect.jobTitle || undefined,
      linkedinUrl: prospect.linkedinUrl || prospect.linkedin || undefined,
      website: prospect.website || prospect.websiteUrl || undefined,
      source: isValidSource(prospect.source) ? prospect.source : 'import',
      status: isValidStatus(prospect.status) ? prospect.status : 'new',
      score: typeof prospect.score === 'number' ? prospect.score : 0,
      tags: Array.isArray(prospect.tags) ? prospect.tags : [],
      notes: prospect.notes || undefined,
    };

    validateProspect(mapped, index + 1);
    return mapped;
  });
}

// ============================================
// LINKEDIN URL IMPORT
// ============================================

export function parseLinkedInUrls(urlText: string): ProspectData[] {
  const lines = urlText.split('\n').map(line => line.trim()).filter(Boolean);
  const prospects: ProspectData[] = [];
  const errors: string[] = [];

  lines.forEach((line, index) => {
    const profile = parseLinkedInUrl(line);

    if (profile.isValid) {
      // Strip trailing LinkedIn numeric ID (e.g. "sneha-jhaveri-095786247" → "sneha-jhaveri")
      const cleanUsername = profile.username
        ? profile.username.replace(/-[0-9a-f]{6,}$/, '')
        : '';
      const displayName = cleanUsername
        ? cleanUsername.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : 'LinkedIn Contact';

      prospects.push({
        name: displayName,
        email: '',
        linkedinUrl: profile.url,
        source: 'linkedin',
        status: 'new',
        score: 15,
      });
    } else {
      errors.push(`Line ${index + 1}: Invalid LinkedIn URL - ${line}`);
    }
  });

  if (prospects.length === 0 && errors.length > 0) {
    throw new Error(`No valid LinkedIn URLs found:\n${errors.join('\n')}`);
  }

  return prospects;
}

// ============================================
// FILE IMPORT
// ============================================

export async function parseProspectsFromFile(file: File): Promise<ProspectData[]> {
  const content = await readFileAsText(file);
  const filename = file.name.toLowerCase();

  if (filename.endsWith('.csv')) {
    return parseProspectsFromCSV(content);
  } else if (filename.endsWith('.json')) {
    return parseProspectsFromJSON(content);
  } else {
    throw new Error('Unsupported file format. Please use CSV or JSON.');
  }
}

// ============================================
// INTERNAL HELPERS
// ============================================

function parseLinkedInUrl(url: string): LinkedInProfile {
  const linkedInPatterns = [
    /^https?:\/\/(www\.)?linkedin\.com\/in\/([a-zA-Z0-9_-]+)\/?(\?.*)?$/,
    /^linkedin\.com\/in\/([a-zA-Z0-9_-]+)\/?(\?.*)?$/,
    /^\/in\/([a-zA-Z0-9_-]+)\/?(\?.*)?$/,
  ];

  for (const pattern of linkedInPatterns) {
    const match = url.match(pattern);
    if (match) {
      const username = match[2] || match[1];
      return {
        url: `https://www.linkedin.com/in/${username}`,
        username,
        isValid: true,
      };
    }
  }

  return { url, isValid: false };
}

function mapCSVRowToProspect(headers: string[], values: string[]): ProspectData {
  const prospect: ProspectData = {
    name: '',
    email: '',
  };

  headers.forEach((header, index) => {
    const value = values[index]?.trim() || '';

    switch (header) {
      case 'name':
      case 'full_name':
      case 'fullname':
        prospect.name = value;
        break;
      case 'email':
      case 'email_address':
        prospect.email = value;
        break;
      case 'phone':
      case 'phone_number':
      case 'mobile':
        prospect.phone = value || undefined;
        break;
      case 'company':
      case 'company_name':
      case 'companyname':
        prospect.company = value || undefined;
        break;
      case 'title':
      case 'job_title':
      case 'jobtitle':
      case 'position':
        prospect.title = value || undefined;
        break;
      case 'linkedin':
      case 'linkedin_url':
      case 'linkedinurl':
        if (value) {
          const profile = parseLinkedInUrl(value);
          prospect.linkedinUrl = profile.isValid ? profile.url : value;
        }
        break;
      case 'website':
      case 'website_url':
      case 'websiteurl':
        prospect.website = value || undefined;
        break;
      case 'source':
        prospect.source = isValidSource(value) ? value as ProspectData['source'] : 'import';
        break;
      case 'status':
        prospect.status = isValidStatus(value) ? value as ProspectData['status'] : 'new';
        break;
      case 'score':
        prospect.score = parseInt(value) || 0;
        break;
      case 'tags':
        prospect.tags = value ? value.split(';').map(t => t.trim()) : [];
        break;
      case 'notes':
      case 'note':
      case 'description':
        prospect.notes = value || undefined;
        break;
    }
  });

  return prospect;
}

function validateProspect(prospect: ProspectData, rowNum: number): void {
  if (!prospect.name || typeof prospect.name !== 'string') {
    throw new Error(`Row ${rowNum}: Missing or invalid 'name' field`);
  }

  // Email is optional for prospects (LinkedIn imports, manual entries often lack email)
  if (prospect.email && !isValidEmail(prospect.email)) {
    throw new Error(`Row ${rowNum}: Invalid email format - ${prospect.email}`);
  }

  if (prospect.website && !isValidUrl(prospect.website)) {
    throw new Error(`Row ${rowNum}: Invalid website URL - ${prospect.website}`);
  }

  if (prospect.score !== undefined && (prospect.score < 0 || prospect.score > 100)) {
    throw new Error(`Row ${rowNum}: Score must be between 0-100`);
  }
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidSource(source: string): boolean {
  const validSources = ['linkedin', 'website', 'referral', 'event', 'manual', 'import'];
  return validSources.includes(source?.toLowerCase());
}

function isValidStatus(status: string): boolean {
  const validStatuses = ['new', 'researching', 'qualified', 'contacted', 'converted', 'disqualified'];
  return validStatuses.includes(status?.toLowerCase());
}
