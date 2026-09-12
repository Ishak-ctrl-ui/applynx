"""Daily automation script for AppKittie.
Runs headless (e.g. in GitHub Actions), refreshes all Apple charts,
updates SQLite snapshots, and regenerates data/apps.json for Netlify.
"""
import sys
import time
import server
from export_json import export_apps


def run_daily_update():
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting daily AppKittie intelligence sync...")
    
    # Run the chart crawl and metadata enrichment synchronously
    server.build_job()
    
    status = dict(server.BUILD)
    print(f"Build job finished with phase={status.get('phase')} apps={status.get('apps')}")
    
    if status.get("phase") == "error":
        print("Build error:", status.get("error"))
        sys.exit(1)
        
    # Export optimized JSON for Netlify static hosting
    print("Exporting updated apps to data/apps.json...")
    export_apps()
    print("Daily sync completed successfully!")


if __name__ == "__main__":
    run_daily_update()
