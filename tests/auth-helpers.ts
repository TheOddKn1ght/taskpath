export const testPassword = "secret";
export const testAuth = {
  username: "test",
  passwordHash: "$argon2id$v=19$m=8192,t=1,p=1$PY6mescJ5z3OEiqGBRjc5qNmHl59ee/F0Q1DoYK/yAo$h6sPwee33mUAao5T3wXNii7qMUpL8I9kcoXfw1pSLNg",
  sessionDays: 30,
};

export async function login(handle: (request: Request) => Promise<Response>, origin = "https://tasks.example.com", username = testAuth.username, password = testPassword) {
  const response = await handle(new Request("http://127.0.0.1:3000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "X-Real-IP": "192.0.2.10" },
    body: JSON.stringify({ username, password }),
  }));
  return { response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] || "" };
}
