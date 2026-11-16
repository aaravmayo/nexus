import { z } from "zod";

export const AssistantUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  welcome_message: z.string().trim().min(1).max(500).optional(),
  brand_color: z.string().trim().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Must be valid hex color").optional(),
  suggested_questions: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
  tone: z.string().trim().min(1).max(50).optional(),
  fallback_info: z.string().trim().min(1).max(500).optional(),
  allowed_origins: z.array(z.string().trim().url()).optional(),
  status: z.enum(["draft", "published"]).optional()
});

export const WebsiteSourceSchema = z.object({
  type: z.literal("website"),
  url: z.string().trim().url()
});

export const FaqSourceSchema = z.object({
  type: z.literal("faq"),
  title: z.string().trim().min(1).max(100).default("FAQs"),
  items: z.array(z.object({
    question: z.string().trim().min(1).max(300),
    answer: z.string().trim().min(1).max(2000)
  })).min(1).max(50)
});

export const TextSourceSchema = z.object({
  type: z.literal("text"),
  title: z.string().trim().min(1).max(100).default("Pasted Text"),
  content: z.string().trim().min(10).max(100000)
});

export const FileSignUploadSchema = z.object({
  type: z.literal("file"),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(["text/plain", "text/markdown", "application/pdf"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024) // 10 MB
});

export const AddSourceSchema = z.discriminatedUnion("type", [
  WebsiteSourceSchema,
  FaqSourceSchema,
  TextSourceSchema,
  FileSignUploadSchema
]);

export const ChatMessageSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  requestId: z.string().trim().min(1).max(100).optional(),
  capabilityToken: z.string().trim().optional() // For public widget
});
