import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const CATEGORIES = [
  'Red Team',
  'Blue Team',
  'OSINT',
  'Malware Analysis',
  'Evasion',
  'Web Security',
  'Hardware',
  'Social Engineering',
  'Mobile',
  'Infrastructure',
  'AI Security',
] as const;

const research = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/research' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    type: z.string(),
    category: z.enum(CATEGORIES),
    difficulty: z.string().optional(),
    readingTime: z.number().optional(),
    video: z.string().url().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    status: z.enum(['public', 'wip', 'research', 'private']).default('public'),
    category: z.enum(CATEGORIES),
    stack: z.array(z.string()).default([]),
    repo: z.string().url().optional(),
    demo: z.string().url().optional(),
    video: z.string().url().optional(),
    writeup: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

const cheatsheets = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/cheatsheets' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    tools: z.array(z.string()).default([]),
    updated: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { research, projects, cheatsheets };
