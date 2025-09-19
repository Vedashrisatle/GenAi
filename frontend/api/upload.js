import multer from "multer";
import nextConnect from "next-connect";
import { google } from "googleapis";
import { VertexAI } from "@google-cloud/vertexai";

// Setup Multer for memory storage (no local filesystem)
const upload = multer({ storage: multer.memoryStorage() });

const apiRoute = nextConnect({
  onError(error, req, res) {
    res.status(501).json({ error: `Something went wrong: ${error.message}` });
  },
  onNoMatch(req, res) {
    res.status(405).json({ error: `Method '${req.method}' not allowed` });
  },
});

apiRoute.use(upload.single("file"));

apiRoute.post(async (req, res) => {
  try {
    const PROJECT_ID = process.env.PROJECT_ID;
    const LOCATION = "us"; // adjust if needed
    const PROCESSOR_ID = process.env.PROCESSOR_ID;

    // Google Auth from env vars (Vercel → Environment Variables)
    const client = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.client_email,
        private_key: process.env.private_key.replace(/\\n/g, "\n"),
      },
      projectId: PROJECT_ID,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });

    const documentai = google.documentai({
      version: "v1",
      auth: client,
    });

    // File buffer from memory
    const fileBuffer = req.file.buffer;
    const encodedFile = fileBuffer.toString("base64");

    const name = `projects/${PROJECT_ID}/locations/${LOCATION}/processors/${PROCESSOR_ID}`;

    const result = await documentai.projects.locations.processors.process({
      name,
      requestBody: {
        rawDocument: {
          content: encodedFile,
          mimeType: req.file.mimetype,
        },
      },
    });

    const text = result.data.document?.text || "";

    if (!text.trim()) {
      return res.status(400).json({ error: "Document contained no extractable text." });
    }

    // Setup Vertex AI
    const vertexAI = new VertexAI({
      project: PROJECT_ID,
      location: "us-central1", // adjust if needed
    });

    const model = vertexAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    // Summary
    const summaryRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: `Summarize the following legal document :\n\n${text}` }],
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 300,
    };

    const summaryResult = await model.generateContent(summaryRequest);
    const summary =
      summaryResult.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Summary not generated";

    // Key terms
    const keyTermsRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: `Extract key terms and their values from the following legal document in a concise bullet-point format:\n\n${text}` }],
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 300,
    };

    const keyTermsResult = await model.generateContent(keyTermsRequest);
    const keyTerms =
      keyTermsResult.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Key terms not extracted";

    // Risk Assessment
    const riskAssessmentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Provide a risk assessment in the following format:\n- Risk Item: Description (Severity: Low/Medium/High)\n\nFor this legal document:\n\n${text}`,
            },
          ],
        },
      ],
      temperature: 0.3,
      maxOutputTokens: 300,
    };

    const riskAssessmentResult = await model.generateContent(riskAssessmentRequest);
    const riskAssessment =
      riskAssessmentResult.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Risk assessment not generated";

    res.json({
      text,
      summary,
      keyTerms,
      riskAssessment,
    });
  } catch (error) {
    console.error("Upload & Analyze error:", error.response?.data || error.message || error);
    res.status(500).json({ error: "Failed to analyze document" });
  }
});

export default apiRoute;

export const config = {
  api: {
    bodyParser: false, // Needed for multer to handle multipart/form-data
  },
};
