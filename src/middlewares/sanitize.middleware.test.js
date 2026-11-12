import test from "node:test";
import assert from "node:assert/strict";
import sanitizeInput from "./sanitize.middleware.js";

const run = (req) => {
  let nextCalled = false;
  sanitizeInput(req, {}, () => {
    nextCalled = true;
  });
  return nextCalled;
};

test("strips markup from names", () => {
  const req = { body: { full_name: "<b>Ali</b>" }, query: {}, params: {} };
  assert.equal(run(req), true);
  assert.equal(req.body.full_name.includes("<"), false);
});

test("keeps only digits in phone fields", () => {
  const req = { body: { phone: "abc 965 1234" }, query: {}, params: {} };
  run(req);
  assert.equal(/[a-zA-Z]/.test(req.body.phone), false);
});

test("lowercases emails", () => {
  const req = { body: { email: "User@Example.COM" }, query: {}, params: {} };
  run(req);
  assert.equal(req.body.email, req.body.email.toLowerCase());
});

test("sanitises nested objects", () => {
  const req = {
    body: { customer: { full_name: "<i>Bad</i>", notes: "<script>x</script>" } },
    query: {},
    params: {},
  };
  run(req);
  assert.equal(req.body.customer.full_name.includes("<"), false);
  assert.equal(req.body.customer.notes.includes("script"), false);
});

test("sanitises arrays of strings and objects", () => {
  const req = {
    body: { tags: ["<b>a</b>", "b"], rows: [{ item_name: "<i>c</i>" }] },
    query: {},
    params: {},
  };
  run(req);
  assert.equal(req.body.tags[0].includes("<"), false);
  assert.equal(req.body.rows[0].item_name.includes("<"), false);
});

test("keeps numbers and booleans untouched", () => {
  const req = { body: { qty: 5, active: true, note: null }, query: {}, params: {} };
  run(req);
  assert.equal(req.body.qty, 5);
  assert.equal(req.body.active, true);
  assert.equal(req.body.note, null);
});

test("skips uploaded file descriptors", () => {
  const file = { fieldname: "image", filename: "a.png" };
  const req = { body: { image: file }, query: {}, params: {} };
  run(req);
  assert.equal(req.body.image.fieldname, "image");
});

test("sanitises route params", () => {
  const req = { body: {}, query: {}, params: { slug: "<b>abc</b>" } };
  run(req);
  assert.equal(req.params.slug.includes("<"), false);
});

test("always calls next even for an unexpected body shape", () => {
  const req = { body: "plain", query: {}, params: {} };
  assert.equal(run(req), true);
});
