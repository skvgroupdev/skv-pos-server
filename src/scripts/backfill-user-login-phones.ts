import "../config/env";
import mongoose, { type AnyBulkWriteOperation } from "mongoose";
import { normalizeLaoMobilePhone } from "../utils/userIdentity";

interface UserIdentityRecord {
  _id: mongoose.Types.ObjectId;
  username?: string;
  phone?: string;
  loginPhone?: string;
}

interface PhoneCandidate {
  userId: mongoose.Types.ObjectId;
  normalizedPhone: string;
  currentLoginPhone?: string;
}

const maskPhone = (phone: string) => `${phone.slice(0, 2)}******${phone.slice(-2)}`;

const run = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");

  const shouldApply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });

  const users = mongoose.connection.collection<UserIdentityRecord>("users");
  const records = await users
    .find(
      {
        $or: [
          { phone: { $exists: true, $ne: "" } },
          { loginPhone: { $exists: true, $ne: "" } },
        ],
      },
      { projection: { username: 1, phone: 1, loginPhone: 1 } },
    )
    .toArray();

  const candidates: PhoneCandidate[] = [];
  let invalidPhoneCount = 0;

  for (const user of records) {
    const normalizedPhone =
      normalizeLaoMobilePhone(user.loginPhone) || normalizeLaoMobilePhone(user.phone);

    if (!normalizedPhone) {
      invalidPhoneCount += 1;
      continue;
    }

    candidates.push({
      userId: user._id,
      normalizedPhone,
      currentLoginPhone: user.loginPhone,
    });
  }

  const candidatesByPhone = new Map<string, PhoneCandidate[]>();
  for (const candidate of candidates) {
    const group = candidatesByPhone.get(candidate.normalizedPhone) || [];
    group.push(candidate);
    candidatesByPhone.set(candidate.normalizedPhone, group);
  }

  const duplicateGroups = Array.from(candidatesByPhone.entries())
    .filter(([, group]) => group.length > 1)
    .map(([phone, group]) => ({
      phone: maskPhone(phone),
      accounts: group.length,
      accountsAlreadyUsingLoginPhone: group.filter((candidate) => candidate.currentLoginPhone).length,
    }));
  const uniqueCandidates = candidates.filter(
    (candidate) => candidatesByPhone.get(candidate.normalizedPhone)?.length === 1,
  );
  const pendingUpdates = uniqueCandidates.filter(
    (candidate) => candidate.currentLoginPhone !== candidate.normalizedPhone,
  );

  const audit = {
    mode: shouldApply ? "apply" : "dry-run",
    scannedAccounts: records.length,
    validPhoneAccounts: candidates.length,
    invalidPhoneAccounts: invalidPhoneCount,
    duplicatePhoneGroups: duplicateGroups,
    accountsReadyForBackfill: pendingUpdates.length,
    accountsSkippedUntilCorrected:
      invalidPhoneCount + duplicateGroups.reduce((sum, group) => sum + group.accounts, 0),
    temporaryVerificationAccounts: records.filter((record) =>
      /^todo_(?:verify|admin)_\d{8}$/.test(record.username || ""),
    ).length,
  };

  console.log(JSON.stringify(audit, null, 2));

  if (!shouldApply) {
    console.log("Dry run only. Re-run with --apply to backfill unique phones; ambiguous accounts will be skipped.");
    return;
  }

  if (duplicateGroups.some((group) => group.accountsAlreadyUsingLoginPhone > 1)) {
    throw new Error("Duplicate loginPhone values already exist; no records were changed.");
  }

  if (pendingUpdates.length > 0) {
    const operations: AnyBulkWriteOperation<UserIdentityRecord>[] = pendingUpdates.map(
      (candidate) => ({
        updateOne: {
          filter: { _id: candidate.userId },
          update: {
            $set: {
              phone: candidate.normalizedPhone,
              loginPhone: candidate.normalizedPhone,
            },
          },
        },
      }),
    );
    await users.bulkWrite(operations, { ordered: true });
  }

  await users.createIndex(
    { loginPhone: 1 },
    { unique: true, sparse: true, name: "loginPhone_1" },
  );

  console.log(JSON.stringify({
    updatedAccounts: pendingUpdates.length,
    skippedAccounts: audit.accountsSkippedUntilCorrected,
    indexReady: true,
  }, null, 2));
};

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
