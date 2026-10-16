import dotenv from "dotenv";
import connectDb from "./config/db.js";
import { server } from "./app.js";

dotenv.config();

connectDb();

const port = process.env.PORT;

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
