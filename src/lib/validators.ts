import { validator } from "hono/validator";
import { HTTP_STATUS } from "@/lib/http-status";

export const idParamValidator = validator("param", (value, c) => {
  const id = value["id"];

  if (!id || !Number.isInteger(parseInt(id ?? "")))
    return c.json(
      {
        error: {
          id: {
            errors: ["Expected number but received a string."],
          },
        },
        message: "Invalid param",
      },
      HTTP_STATUS.BAD_REQUEST,
    );
  return {
    id: parseInt(id),
  };
});
