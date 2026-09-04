async function readHidden(label: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const value = (await Bun.stdin.text()).replace(/\r?\n$/, "");
    if (!value) throw new Error("No password was provided on standard input.");
    return value;
  }
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

try {
  const password = await readHidden("New password: ");
  if (password.length < 12) throw new Error("Use at least 12 characters.");
  if (process.stdin.isTTY) {
    const confirmation = await readHidden("Confirm password: ");
    if (password !== confirmation) throw new Error("Passwords do not match.");
  }
  console.log(await Bun.password.hash(password, { algorithm: "argon2id" }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not hash the password.");
  process.exit(1);
}
