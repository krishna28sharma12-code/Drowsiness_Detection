// DriveGuard: serves the page. Driver monitoring now runs on the phone itself.
const path = require("path");
const express = require("express");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("DriveGuard running on port " + PORT));
