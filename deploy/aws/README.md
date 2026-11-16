# Deploy Hiring Pulse on AWS

One command creates everything in **Mumbai (ap-south-1)** and gives you an `https://` address.

## What gets created

| Piece | Details |
|---|---|
| EC2 server | Ubuntu 24.04, `t3.small`, in your default VPC. Runs the app and Caddy (automatic HTTPS) with Docker. |
| Disk | 20 GB gp3, **encrypted**. The database `pulse.db` lives at `/srv/hiring-pulse/data/` on this disk. |
| Elastic IP | A fixed public IP, so the address and QR code never change. |
| Security group | Only ports 80 and 443 open. **No SSH**; use Session Manager (below). |
| Daily snapshots | Disk snapshots every night at 02:00 IST, kept 14 days (Data Lifecycle Manager). |
| S3 bucket | Private and encrypted. Holds the app releases only, never candidate data. |
| SSM Parameter Store | The staff PIN, encrypted (`/hiring-pulse/staff-pin`). |

## Deploy (about 10 minutes)

You need an AWS user who can create EC2, IAM roles, S3, SSM and CloudFormation resources (an admin is simplest).

1. Sign in to the AWS Console and switch the region (top right) to **Asia Pacific (Mumbai) ap-south-1**.
2. Open **CloudShell** (the `>_` icon in the top bar). It already has the AWS CLI and your credentials.
3. **Actions → Upload file** → choose `upcruit-hiring-pulse.zip`.
4. Run:

   ```bash
   unzip -q upcruit-hiring-pulse.zip && cd upcruit-hiring-pulse
   bash deploy/aws/deploy.sh
   ```

5. Type a staff PIN when asked (8+ characters, no spaces or `'`). Wait for **"Hiring Pulse is live."**

You'll get an address like `https://13-234-56-78.sslip.io`. That's a free hostname that points at your server's IP, with a real HTTPS certificate, so it works right away without a domain.

**Then:** open the address → **Staff desk** → enter the PIN → upload the jobs Excel file. Open **TV display** on the booth laptop and **Booth tablet** on the tablet.

## Use your own domain (e.g. pulse.upcruit.ai)

1. At your DNS provider (or Route 53), create an **A record**: `pulse.upcruit.ai` → the **Public IP** the script printed.
2. Wait a few minutes for DNS to update, then in CloudShell:

   ```bash
   cd upcruit-hiring-pulse && DOMAIN=pulse.upcruit.ai bash deploy/aws/deploy.sh
   ```

Do this **before the booth opens**: switching the domain restarts the server once, which takes about 2 minutes.
Or use the domain from the start: `DOMAIN=pulse.upcruit.ai bash deploy/aws/deploy.sh` on the first run, with the A record created as soon as the IP is printed. HTTPS starts working once DNS points at the server.

## Update the app later

Replace the files in the `upcruit-hiring-pulse` folder in CloudShell (e.g. upload a new zip and unzip it over the old one), then:

```bash
cd upcruit-hiring-pulse && bash deploy/aws/deploy.sh
```

The script uploads the new version and restarts the app in about a minute. **Candidates, jobs and settings are kept.**

**Change the staff PIN:** `NEW_PIN=1 bash deploy/aws/deploy.sh`

## Where the data is and how to get it

- **Database:** `/srv/hiring-pulse/data/pulse.db` on the server's encrypted disk.
- **Easiest export:** Staff desk → **Download all answers with contact details (.csv)**.
- **Copy the database file** (from CloudShell):

  ```bash
  aws ssm start-session --target <InstanceId> --region ap-south-1
  # then on the server:
  sudo cp /srv/hiring-pulse/data/pulse.db /tmp/pulse.db && sudo chmod 644 /tmp/pulse.db
  ```

  Or just restore from a snapshot (EC2 → Snapshots, filtered by tag `Backup = hiring-pulse`).

## Server access, logs, troubleshooting

```bash
aws ssm start-session --target <InstanceId> --region ap-south-1   # shell on the server, no SSH needed
sudo tail -50 /var/log/hiring-pulse-setup.log                       # first-boot setup log
cd /opt/hiring-pulse && sudo docker compose logs --tail 100 app     # app log
sudo docker compose logs --tail 100 caddy                           # HTTPS/certificate log
sudo /opt/hiring-pulse/update.sh                                    # reinstall + restart the current version
```

| Problem | Fix |
|---|---|
| Stack creation fails with a VPC or subnet error | Your account has no default VPC. Create one: VPC console → **Actions → Create default VPC**. Then run the script again. |
| Address doesn't load after a few minutes | `docker compose logs caddy` shows certificate errors. With your own domain, check the A record points at the Public IP. |
| Staff desk says "Wrong PIN" | Reset it: `NEW_PIN=1 bash deploy/aws/deploy.sh`. |
| Visitors see "Too many answers from this device" | The server allows 300 per minute per IP. Expo Wi-Fi can put everyone behind one IP; tell us and we'll raise it. |

## Cost (approximate)

Fixed and small: one `t3.small` server, a 20 GB disk, an Elastic IP and snapshots. Nothing is billed per visitor. Check the exact figure for ap-south-1 in the AWS Pricing Calculator.

## Remove everything after the event

1. **Download the CSV first.**
2. CloudFormation console → stack **hiring-pulse** → **Delete**. This deletes the server and its disk (and the database with it).
3. Also delete: EC2 → Snapshots with tag `Backup = hiring-pulse`; the S3 bucket `hiring-pulse-<account>-ap-south-1`; Parameter Store `/hiring-pulse/staff-pin`.
