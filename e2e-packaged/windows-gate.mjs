await new Promise((resolve) => {
  const abort = () => process.exit(70);
  process.once("disconnect", abort);
  process.once("message", (message) => {
    if (message !== "go") abort();
    process.off("disconnect", abort);
    process.disconnect();
    resolve();
  });
});
