import formidable from "formidable";
import { google } from "googleapis";
import { VertexAI } from "@google-cloud/vertexai";

// Disable bodyParser so formidable can handle multipart
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  try {
    // Parse incoming form
    const form = formidable({ multiples: false });
    const [fields, files] = await form.parse(req);

    const file = files.file;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Read file into buffer
    const fs = await import("fs");
    const fileBuffer = await fs.promises.readFile(file[0].filepath);
    const encodedFile = fileBuffer.toString("base64");

    // Google Document AI
    const PROJECT_ID = process.env.PROJECT_ID;
    const LOCATION = "us"; // adjust
    const PROCESSOR_ID = process.env.PROCESSOR_ID;

    const client = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.client_email,
        private_key: process.env.private_key.replace(/\\n/g, "\n"),
      },
      projectId: PROJECT_ID,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });

    const documentai = google.documentai({ version: "v1", auth: client });

    const name = `projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}`;
    const result = await documentai.projects.locations.processors.process({
      name,
      requestBody: {
        rawDocument: {
          content: encodedFile,
          mimeType: file[0].mimetype,
        },
      },
    });

    const text = result.data.document?.text || "";
    if (!text.trim()) {
      return res.status(400).json({ error: "Document contained no extractable text." });
    }

    // Vertex AI
    const vertexAI = new VertexAI({ project: PROJECT_ID, location: "us-central1" });
    const model = vertexAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    async function ask(prompt) {
      const resp = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        temperature: 0.3,
        maxOutputTokens: 300,
      });
      return resp.response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    const summary = await ask(`Summarize this legal document:\n\n${text}`);
    const keyTerms = await ask(`Extract key terms in bullet-point format:\n\n${text}`);
    const riskAssessment = await ask(
      `Provide a risk assessment in this format:
- Risk Item: Description (Severity: Low/Medium/High)

For this legal document:\n\n${text}`
    );

    res.status(200).json({ text, summary, keyTerms, riskAssessment });
  } catch (error) {
    console.error("Upload & Analyze error:", error);
    res.status(500).json({ error: "Failed to analyze document" });
  }
}
